import fetch from "node-fetch";

const API_URL = "http://localhost:3000/api/learning/embeddings/backfill";

async function main() {
  console.log("Triggering RAG embeddings backfill...");
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (res.ok) {
      console.log("Success:", data);
    } else {
      console.error("Error:", data);
    }
  } catch (err) {
    console.error("Failed to connect to server:", err.message);
  }
}

main();
