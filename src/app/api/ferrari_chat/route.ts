import {
    Message as VercelChatMessage,
    StreamingTextResponse,
    createStreamDataTransformer
} from 'ai';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { HttpResponseOutputParser } from 'langchain/output_parsers';
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from '@langchain/core/documents';
import { formatDocumentsAsString } from 'langchain/util/document';
import { RunnableSequence } from '@langchain/core/runnables';
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";

async function initializeVectorStore() {
    try {
        const embeddings = new OpenAIEmbeddings({
            model: "text-embedding-3-small",
        });

        const pinecone = new PineconeClient();
        const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
            maxConcurrency: 5,
        });
        return { vectorStore, pineconeIndex };
    } catch (error) {
        console.error("Error initializing vector store:", error);
        throw new Error("Failed to initialize vector store");
    }
}

const ferrariManualPath = "src/data/Ferrari_458_Spider_Owners_Manual.pdf";

const loader = new PDFLoader(ferrariManualPath);

export const dynamic = 'force-dynamic';

const formatMessage = (message: VercelChatMessage) => {
    return `${message.role}: ${message.content}`;
};

const TEMPLATE = `Answer the user's questions based on the following context. If the answer is not in the context, reply politely that you do not have that information available.:
==============================
Context: {context}
==============================
Current conversation: {chat_history}

user: {question}
assistant:;`

// Utility function to check if the document is already indexed in Pinecone
async function isDocumentIndexed(pineconeIndex: any, docId: string): Promise<boolean> {
    try {
        const queryResponse = await pineconeIndex.query({
            vector: new Array(1536).fill(0), 
            topK: 1,
            includeMetadata: true,
            filter: {
                "metadata.id": docId
            }
        });
        return queryResponse.matches.length > 0;
    } catch (error) {
        console.error("Error querying Pinecone:", error);
        return false;
    }
}

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();

        if (!messages || messages.length === 0) {
            return Response.json({ error: "No messages provided" }, { status: 400 });
        }

        const formattedPreviousMessages = messages.slice(0, -1).map(formatMessage);
        const currentMessageContent = messages[messages.length - 1].content;

        // Initialize the vector store
        const { vectorStore, pineconeIndex } = await initializeVectorStore();

        const docId = 'Ferrari_458_Spider_Manual';

        // Check if the document is already indexed
        const isIndexed = await isDocumentIndexed(pineconeIndex, docId);

        if (!isIndexed) {
            // Load the documents
            const docs = await loader.load();
            if (!docs || docs.length === 0) {
                return Response.json({ error: "Failed to load documents" }, { status: 500 });
            }

            // Add documents to the vector store with metadata
            await vectorStore.addDocuments(docs.map((doc, i) => ({
                ...doc,
                metadata: { id: docId, text: doc.pageContent }
            })));
        }

        // Create an embedding for the user's query
        const queryEmbedding = await vectorStore.embeddings.embedQuery(currentMessageContent);

        // Retrieve relevant documents based on the query from Pinecone
        const retrievalResults = await pineconeIndex.query({
            vector: queryEmbedding,
            topK: 5,
            includeMetadata: true,
        });

        if (!retrievalResults.matches || retrievalResults.matches.length === 0) {
            return Response.json({ error: "No relevant documents found" }, { status: 404 });
        }

        // Extract and format the documents
        const documents = retrievalResults.matches
        .filter(match => match.metadata?.text) // Only include matches with valid text
        .map(match => new Document({
            pageContent: String(match.metadata!.text), // Convert to string safely
            metadata: { id: match.id }
        }));

        const context = formatDocumentsAsString(documents);

        const prompt = PromptTemplate.fromTemplate(TEMPLATE);

        const model = new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY!,
            model: 'gpt-4o-mini',
            temperature: 0,
            streaming: true,
            verbose: true,
        });

        const parser = new HttpResponseOutputParser();

        const chain = RunnableSequence.from([
            {
                question: (input) => input.question,
                chat_history: (input) => input.chat_history,
                context: () => context,  // Use the context from Pinecone
            },
            prompt,
            model,
            parser,
        ]);

        const stream = await chain.stream({
            chat_history: formattedPreviousMessages.join('\n'),
            question: currentMessageContent,
        });

        return new StreamingTextResponse(
            stream.pipeThrough(createStreamDataTransformer()),
        );
    } catch (e: any) {
        console.error("Error processing request:", e);
        return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
}
