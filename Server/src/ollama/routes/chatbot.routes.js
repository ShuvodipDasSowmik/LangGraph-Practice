import express from "express";
import multer from "multer";
import { insertCSVToDB, getRAGAnswer, listTopics, createTopic, getMessagesByTopic, postMessageAndStream, planAndRunDataQuery } from "../controllers/chatbot.controller.js";
import { runDataAgent } from "../../slm/dataAgent.js";

const router = express.Router();

// Multer setup for file upload
const upload = multer({ dest: "uploads/" });

// Route: Upload CSV
router.post("/upload-csv", upload.single("file"), async (req, res) => {
    try {
        console.log("Uploading CSV:", req.file?.originalname);
        
        if (!req.file) return res.status(400).json({ error: "CSV file required" });
        // If topicId is provided in the form body, bind this upload to that topic
        const topicId = req.body.topicId || null;
        const result = await insertCSVToDB(req.file.path, { topicId, originalName: req.file.originalname });
        res.json({ message: "CSV inserted", ...result });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to insert CSV" });
    }
});

// Route: Ask RAG chatbot
router.post("/ask", async (req, res) => {
    try {
        const { question } = req.body;
        console.log(question);
        
        if (!question) return res.status(400).json({ error: "Question required" });

        const answer = await getRAGAnswer(question);
        res.json({ answer });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to get answer" });
    }
});

// Data query for a topic: planner + execution
router.post('/topics/:id/query-data', async (req, res) => {
    try {
        const topicId = req.params.id;
        const { question, limit } = req.body;
        if (!question) return res.status(400).json({ error: 'Question required' });
        const result = await planAndRunDataQuery(topicId, question, { limit: limit || 100 });
        res.json(result);
    } catch (err) {
        console.error('query-data error', err);
        res.status(500).json({ error: 'Failed to plan or run data query' });
    }
});

// Agent-driven data query using LangGraph: plans and runs queries using tools
router.post('/topics/:id/agent-query', async (req, res) => {
    try {
        const topicId = req.params.id;
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: 'Question required' });

        const result = await runDataAgent(topicId, question);
        // Log the agent trace server-side for observability
        if (result.trace && result.trace.length) {
            console.log('[agent-query] execution trace:');
            for (const t of result.trace) console.log('  ', t);
        }

        // Only send the final assistant answer to the frontend (do not expose tool call internals)
        res.json({ answer: result.answer });
    } catch (err) {
        console.error('agent-query error', err);
        res.status(500).json({ error: 'Failed to run data agent', detail: err.message });
    }
});

// Topics list
router.get('/topics', async (req, res) => {
    try {
        const topics = await listTopics();
        console.log(topics);
        
        res.json(topics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to list topics' });
    }
});

// Create topic
router.post('/topics', async (req, res) => {
    try {
        const { id, title, subtitle } = req.body;
        console.log(title);
        
        const topic = await createTopic({ id, title, subtitle });
        res.json(topic);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create topic' });
    }
});

// Get messages for a topic
router.get('/topics/:id/messages', async (req, res) => {
    try {
        const msgs = await getMessagesByTopic(req.params.id);
        res.json(msgs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// Post a message to a topic and stream assistant reply
router.post('/topics/:id/messages', upload.single('file'), async (req, res) => {
    // postMessageAndStream will handle streaming and DB writes
    return postMessageAndStream(req, res);
});

export default router;
