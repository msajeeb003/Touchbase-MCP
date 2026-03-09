import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import AppError from "../errors/AppError";

type AIProvider = "openai" | "gemini";

interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model?: string;
}

interface AIResponse {
  content: string;
}

const DEFAULT_MODELS: Record<AIProvider, string> = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const generateWithOpenAI = async (
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> => {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are an expert copywriter specializing in follow-up email and SMS sequences. Generate content exactly as instructed.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new AppError(500, "AI returned empty response");
  }

  return text;
};

const generateWithGemini = async (
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> => {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });

  const result = await geminiModel.generateContent(prompt);
  const text = result.response.text();

  if (!text) {
    throw new AppError(500, "AI returned empty response");
  }

  return text;
};

export const generateContent = async (
  config: AIConfig,
  prompt: string
): Promise<AIResponse> => {
  const model = config.model || DEFAULT_MODELS[config.provider];

  try {
    let content: string;

    if (config.provider === "openai") {
      content = await generateWithOpenAI(config.apiKey, model, prompt);
    } else if (config.provider === "gemini") {
      content = await generateWithGemini(config.apiKey, model, prompt);
    } else {
      throw new AppError(400, `Unsupported AI provider: ${config.provider}`);
    }

    return { content };
  } catch (error) {
    if (error instanceof AppError) throw error;

    const message =
      error instanceof Error ? error.message : "AI generation failed";
    throw new AppError(502, `AI provider error: ${message}`);
  }
};
