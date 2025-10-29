import { ChatOllama } from "@langchain/ollama";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage, SystemMessage, ToolMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { registry } from "@langchain/langgraph/zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { StateGraph, END } from "@langchain/langgraph";
import { initializeDatabase } from "../config/sqlite.js";

const model = new ChatOllama({ model: "llama3.2:3b", temperature: 0 });

// Tool: get_schema(topicId) -> returns the schema (array of {table, columns})
const GetSchemaTool = tool(async ({ topicId }) => {
    const db = await initializeDatabase();
    const rows = await db.all(`SELECT table_name, schema_json FROM uploaded_tables WHERE topic_id = ? ORDER BY created_at DESC`, [topicId]);
    const schema = rows.map(r => ({ table: r.table_name, columns: JSON.parse(r.schema_json || '[]') }));
    return schema;
}, {
    name: 'get_schema',
    description: 'Return uploaded table schemas for a given topic id',
    schema: z.object({ topicId: z.string().describe('Conversation topic id') })
});

// Tool: execute_query(plan) -> runs safe SQL built from a validated plan and returns rows
const ExecuteQueryTool = tool(async (plan) => {
    const db = await initializeDatabase();
    // plan: { table, select, where, group_by, limit }
    const table = String(plan.table || '');
    const safeTable = table.replace(/[^A-Za-z0-9_]/g, '_');
    const cols = Array.isArray(plan.select) && plan.select.length ? plan.select : ['*'];

    // basic validation: column names must be simple identifiers
    const validCol = (c) => /^[A-Za-z0-9_]+$/.test(c);
    for (const c of cols) {
        if (c !== '*' && !validCol(c)) throw new Error(`Invalid column name: ${c}`);
    }

    const selectSql = cols.join(', ');
    const whereParts = [];
    const params = [];
    if (Array.isArray(plan.where)) {
        for (const w of plan.where) {
            if (!w || !w.column) continue;
            if (!validCol(w.column)) throw new Error(`Invalid where column: ${w.column}`);
            const op = (w.op || '=').toUpperCase();
            if (!['=','>','<','>=','<=','LIKE'].includes(op)) throw new Error(`Unsupported op: ${op}`);
            whereParts.push(`"${w.column}" ${op} ?`);
            params.push(String(w.value));
        }
    }

    const groupBy = Array.isArray(plan.group_by) ? plan.group_by.filter(validCol) : [];
    const limit = Number(plan.limit || 100) || 100;

    const sqlParts = [`SELECT ${selectSql}`, `FROM "${safeTable}"`];
    if (whereParts.length) sqlParts.push('WHERE ' + whereParts.join(' AND '));
    if (groupBy.length) sqlParts.push('GROUP BY ' + groupBy.join(', '));
    sqlParts.push('LIMIT ' + limit);
    const sql = sqlParts.join(' ');

    const rows = await db.all(sql, params);
    return { sql, params, rows };
}, {
    name: 'execute_query',
    description: 'Execute a validated query plan and return rows',
    schema: z.object({
        table: z.string().describe('Table name'),
        select: z.array(z.string()).optional(),
        where: z.array(z.object({ column: z.string(), op: z.string(), value: z.any() })).optional(),
        group_by: z.array(z.string()).optional(),
        limit: z.number().optional()
    })
});

const toolsByName = {
    [GetSchemaTool.name]: GetSchemaTool,
    [ExecuteQueryTool.name]: ExecuteQueryTool,
};
const tools = Object.values(toolsByName);
const SLMWithTools = model.bindTools(tools);

// Messages state schema registration (LangGraph requirement for BaseMessage types)
const MessagesState = z.object({
    messages: z.array(z.custom((val) => val instanceof BaseMessage)).register(registry, MessagesZodMeta),
    llmCalls: z.number().optional(),
    // trace stores a list of executed node/tool events for observability (server-side)
    trace: z.array(z.string()).optional(),
});

// LLM call node
async function llmCall(state) {
    // record node execution
    state.trace = [...(state.trace || []), 'node:llmCall:start'];
    console.log('[dataAgent] node=llmCall start');

    const systemText = `You are a data agent that can call two tools:
1) get_schema(topicId) -> returns the list of uploaded tables and their columns for the conversation.
2) execute_query(plan) -> executes a validated query plan against a single uploaded table and returns rows.

Required behavior:
- First, call get_schema with the provided topicId to discover available tables and columns.
- Then, produce a JSON plan and call execute_query. The plan JSON must be an object with keys: table (string), select (array of column names or aggregate objects), where (array of {column, op, value}), group_by (array), limit (number).
- Allowed aggregates: {"agg":"COUNT|SUM|AVG|MIN|MAX", "column":"col", "alias":"name"}.
- Allowed ops: =, >, <, >=, <=, LIKE. Values must be plain strings or numbers. Do not return raw SQL or call any other tools.
- After execute_query returns results, synthesize a concise human-readable answer summarizing the requested metric(s) or listing rows as requested.

Always return final decisions as an assistant message (do not output raw tool internals). Example execute_query plan:
{
  "table":"sales_2025",
  "select":[{"agg":"SUM","column":"revenue","alias":"total_revenue"}],
  "where":[],
  "group_by":["region"],
  "limit":50
}

If you cannot build a valid plan, return a short explanation in an assistant message and do not call execute_query.`;

    const result = await SLMWithTools.invoke([
        new SystemMessage(systemText),
        ...(state.messages || [])
    ]);

    // debug: log whether the returned AI messages contained tool calls
    try {
        const msgs = Array.isArray(result) ? result : [result];
        for (const m of msgs) {
            if (AIMessage.isInstance(m)) {
                console.log('[dataAgent] llmCall -> AIMessage tool_calls count=', (m.tool_calls || []).length);
                if (m.tool_calls && m.tool_calls.length) console.log('[dataAgent] llmCall -> tool_call[0]=', m.tool_calls[0]);
            }
        }
    } catch (e) {
        console.warn('[dataAgent] failed to inspect llm result for tool_calls', e?.message || e);
    }

    // record completion
    state.trace = [...(state.trace || []), `node:llmCall:done:messages=${Array.isArray(result) ? result.length : 1}`];
    console.log('[dataAgent] node=llmCall done');

    return { messages: result, llmCalls: (state.llmCalls || 0) + 1, trace: state.trace };
}

// Tool node: execute the tool call present in the last AI message
async function toolNode(state) {
    const lastMessage = state.messages.at(-1);
    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) return { messages: [] };

    const toolCall = lastMessage.tool_calls && lastMessage.tool_calls[0];
    if (!toolCall) return { messages: [] };

    const tool = toolsByName[toolCall.name];
    if (!tool) return { messages: [new ToolMessage({ content: `Unknown tool: ${toolCall.name}`, tool_call_id: toolCall.id })] };

    // record node execution and tool name
    state.trace = [...(state.trace || []), `node:toolNode:start:${toolCall.name}`];
    console.log('[dataAgent] node=toolNode start tool=', toolCall.name);

    // Tool args are provided by the model
    const args = toolCall.args || {};
    const observation = await tool.invoke(args);

    // record completion
    state.trace = [...(state.trace || []), `node:toolNode:done:${toolCall.name}`];
    console.log('[dataAgent] node=toolNode done tool=', toolCall.name);

    return { messages: [new ToolMessage({ content: JSON.stringify(observation), tool_call_id: toolCall.id })], trace: state.trace };
}

async function shouldContinue(state) {
    const lastMessage = state.messages.at(-1);
    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) return END;
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) return 'toolNode';
    return END;
}

const dataAgentGraph = new StateGraph(MessagesState)
    .addNode('llmCall', llmCall)
    .addNode('toolNode', toolNode)
    .addEdge('__start__', 'llmCall')
    .addConditionalEdges('llmCall', shouldContinue, { toolNode: 'toolNode', [END]: END })
    .addEdge('toolNode', 'llmCall')
    .compile();

export async function runDataAgent(topicId, question) {
    const initialState = {
        messages: [
            new HumanMessage(question),
            new SystemMessage(`Conversation topic id: ${topicId}. When calling get_schema pass this topic id.`)
        ],
    };

    const finalState = await dataAgentGraph.invoke(initialState);

    // Log trace server-side for observability
    if (finalState.trace && finalState.trace.length) {
        console.log('[dataAgent] execution trace:');
        for (const t of finalState.trace) console.log('  ', t);
    }

    // Extract final AI answer (do not expose tool internals to frontend)
    const msgs = finalState.messages || [];
    const ai = msgs.slice().reverse().find(m => AIMessage.isInstance(m));
    const answer = ai ? (ai.content || '') : (msgs.length ? JSON.stringify(msgs) : '');

    // If the agent didn't call any tools (no toolNode in trace), try a fallback:
    // fetch schema programmatically and re-run the agent with a ToolMessage containing the schema.
    const hasToolNode = (finalState.trace || []).some(t => t.startsWith('node:toolNode'));
    if (!hasToolNode) {
        try {
            console.log('[dataAgent] no toolNode observed — running fallback: preloading schema and re-invoking agent');
            const schema = await GetSchemaTool.invoke({ topicId });
            // build a new state that includes the schema observation as a ToolMessage
            const fallbackState = {
                messages: [
                    new HumanMessage(question),
                    new SystemMessage(`Preloaded schema for topic ${topicId}`),
                    new ToolMessage({ content: JSON.stringify({ schema }), tool_call_id: 'preloaded_get_schema' })
                ],
            };

            const secondState = await dataAgentGraph.invoke(fallbackState);
            if (secondState.trace && secondState.trace.length) {
                console.log('[dataAgent] second run execution trace:');
                for (const t of secondState.trace) console.log('  ', t);
            }
            const msgs2 = secondState.messages || [];
            const ai2 = msgs2.slice().reverse().find(m => AIMessage.isInstance(m));
            const answer2 = ai2 ? (ai2.content || '') : (msgs2.length ? JSON.stringify(msgs2) : '');
            return { answer: answer2, trace: secondState.trace };
        } catch (e) {
            console.warn('[dataAgent] fallback failed:', e?.message || e);
            // return original answer (may be empty) and trace
            return { answer, trace: finalState.trace };
        }
    }

    return { answer, trace: finalState.trace };
}

export default runDataAgent;
