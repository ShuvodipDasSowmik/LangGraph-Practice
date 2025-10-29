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


// Optionally spawn Ollama locally. If the binary is not available, do not crash the server.
if (process.env.START_OLLAMA === '1') {
    try {
        const ollama = spawn("ollama", ["run", "phi3mini"], {
            stdio: "inherit"
        });

        // Ensure Ollama shuts down if Node exits
        process.on("exit", () => ollama.kill());

        process.on("SIGINT", () => {
            try { ollama.kill(); } catch (e) {}
            process.exit();
        });

        process.on("SIGTERM", () => {
            try { ollama.kill(); } catch (e) {}
            process.exit();
        });
    } catch (e) {
        console.error('Failed to spawn Ollama process, continuing without it:', e?.message || e);
    }
} else {
    console.log('START_OLLAMA not set; skipping spawning local Ollama to keep server running.');
}




export default app;