import { ChatOllama } from "@langchain/ollama";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage } from "@langchain/core/messages";

const model = new ChatOllama({
    model: "llama3.2:3b",
    temperature: 0
})

const add = tool(({ a, b }) => a + b, {
    name: "add",
    description: "Add two numbers",
    schema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
    }),
});

const multiply = tool(({ a, b }) => a * b, {
    name: "multiply",
    description: "Multiply two numbers",
    schema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
    }),
});

const divide = tool(({ a, b }) => a / b, {
    name: "divide",
    description: "Divide two numbers",
    schema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
    }),
});

// Useful when there are way to many tools and we have to hard code them each
/*
    Instead we can do

    const tools = [add, multiply, divide];
    for (const tool of tools) {
        toolsByName[tool.name] = tool;
    }

    const toolsObj = Object.values(tools);
*/

const toolsByName = {
    [add.name]: add,
    [multiply.name]: multiply,
    [divide.name]: divide,
};

// Array of all tools
// tools = [add, multiply, divide];

const tools = Object.values(toolsByName);

const SLMWithMathTools = model.bindTools(tools);


// DEFINE STATE 

import { registry } from "@langchain/langgraph/zod";
import { MessagesZodMeta } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";


/*
    BaseMessage is the base class for all message types in LangChain: AIMessage, HumanMessage, SystemMessage, ToolMessage, etc.

    MessagesState defines the state structure for the agent

    registry is used to register custom Zod schemas for complex types like BaseMessage
    register(MessagesZodMeta) tells the registry how to handle BaseMessage serialization/
    deserialization

    MessagesZodMeta is a Zod schema that defines the structure of BaseMessage and its subclasses
*/
const MessagesState = z.object({
    messages: z.array(z.custom((val) => {
        // Optional runtime check: ensure val is a BaseMessage instance
        return val instanceof BaseMessage;
    })).register(registry, MessagesZodMeta),

    llmCalls: z.number().optional(),
});


// DEFINE Model NODE

import { SystemMessage } from "@langchain/core/messages";

/*
    llmCall node: calls the LLM with the current messages in state
*/

async function llmCall(state) {
    const result = await SLMWithMathTools.invoke([
        new SystemMessage(
            "You are a helpful assistant tasked with performing arithmetic on a set of inputs step by step."
        ),
        ...(state.messages || []), // ensure messages array exists
    ]);

    return {
        messages: result,
        llmCalls: (state.llmCalls || 0) + 1,
    };
}


// DEFINE TOOL NODE
import { ToolMessage } from "@langchain/core/messages";

async function toolNode(state) {
    const lastMessage = state.messages.at(-1);

    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
        return { messages: [] };
    }

    const result = [];


    const tool = toolsByName[lastMessage.tool_calls[0].name];

    const args = {
        a: Number(lastMessage.tool_calls[0].args.a),
        b: Number(lastMessage.tool_calls[0].args.b),
    };

    const observation = await tool.invoke(args);
    result.push(
        new ToolMessage({
            content: String(observation),
            tool_call_id: lastMessage.tool_calls[0].id
        })
    );

    return { messages: result };
}

// DEFINE END LOGIC

import { END } from "@langchain/langgraph";

async function shouldContinue(state) {
    const lastMessage = state.messages.at(-1);

    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
        return END;
    }

    // If the LLM makes a tool call, go to toolNode
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "toolNode";
    }

    // Otherwise, stop the
    return END;
}

// BUILD THE AGENT

import { StateGraph } from "@langchain/langgraph";

const mathAgentGraph = new StateGraph(MessagesState)
    .addNode("llmCall", llmCall)
    .addNode("toolNode", toolNode)
    .addEdge("__start__", "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, {
        toolNode: "toolNode",
        [END]: END,
    })
    .addEdge("toolNode", "llmCall")
    .compile();

// RUN THE AGENT

import { HumanMessage } from "@langchain/core/messages";

const initialState = {
    messages: [
        new HumanMessage("What is 12 multiplied by 7, then divided by 3, and then add 10,, then multiply 3?"),
    ],
};
const finalState = await mathAgentGraph.invoke(initialState);

console.log("Final Messages: ", finalState.messages);
console.log("Total LLM Calls: ", finalState.llmCalls);