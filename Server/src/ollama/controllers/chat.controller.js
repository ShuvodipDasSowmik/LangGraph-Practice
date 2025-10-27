class SLMController {
    async generate(req, res, next) {
        const { prompt, temperature = 0, num_predict = 256 } = req.body;

        let responseData = '';

        try {
            console.log("Prompt:", prompt);

            const response = await fetch("http://127.0.0.1:11434/api/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama3.2:3b",
                    prompt,
                    stream: true, // Enable streaming
                    options: {
                        temperature,
                        repeat_penalty: 1.2,
                        top_p: 0.95,
                        top_k: 100
                    }
                }),
            });

            if (!response.ok) {
                throw new Error(`Ollama API error: ${response.statusText}`);
            }

            // Set headers for streaming response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Read the stream and forward it to the client
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    res.end();
                    break;
                }

                // Decode and send the chunk
                const chunk = decoder.decode(value, { stream: true });
                console.log("Streaming chunk:", chunk);
                responseData += JSON.parse(chunk).response;
                res.write(chunk);
            }

            console.log("Response: ", responseData);

            return responseData

        }
        catch (err) {
            console.error('Error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
        finally {
            if (!res.headersSent) {
                res.end();
            }
            next();
        }
    }
}

export default new SLMController();