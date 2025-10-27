import express from 'express';
const app = express();
import cors from 'cors';
import { spawn } from 'child_process';
import ollamaRoutes from './ollama/ollama-index.js';

app.use(express.json());
app.use(cors(
    {origin: ['http://localhost:5173']}
));

app.use('/', ollamaRoutes);


const ollama = spawn("ollama", ["run", "phi3mini"], {
    stdio: "inherit"
});

// Ensure Ollama shuts down if Node exits
process.on("exit", () => ollama.kill());

process.on("SIGINT", () => {
    ollama.kill();
    process.exit();
});

process.on("SIGTERM", () => {
    ollama.kill();
    process.exit();
});




export default app;