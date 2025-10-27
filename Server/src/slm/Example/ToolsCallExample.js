import { ChatOllama } from "@langchain/ollama";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { AIMessage } from "@langchain/core/messages";

const model = new ChatOllama({
    model: "llama3.2:3b",
    temperature: 0
})

const GetWeather = {
    name: "GetWeather",
    description: "Get the current weather in a given location",
    schema: z.object({
        location: z.string().describe("The city and state, e.g. San Francisco, CA")
    }),
}


const GetPopulation = {
    name: "GetPopulation",
    description: "Get the current population in a given location",
    schema: z.object({
        location: z.string().describe("The city and state, e.g. San Francisco, CA")
    }),
}

const SLMWithTools = model.bindTools([GetWeather, GetPopulation]);

const aiMsg = await SLMWithTools.invoke(
    "Which city is bigger? Sylhet or Dhaka?"
);

console.log(aiMsg.tool_calls);
console.log(aiMsg);
