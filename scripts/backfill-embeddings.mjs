import 'dotenv/config';

const API = process.env.RAZORVASOOLI_API || 'http://127.0.0.1:5000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@razorvasooli.in";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

async function main() {
  console.log("Logging in...");
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error("Login failed:", await loginRes.text());
    process.exit(1);
  }
  
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    console.error("No session cookie returned");
    process.exit(1);
  }

  console.log("Triggering RAG embeddings backfill...");
  try {
    const res = await fetch(`${API}/api/learning/embeddings/backfill`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Cookie": cookie
      }
    });
    
    // Some endpoints return empty body or plain text
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

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
