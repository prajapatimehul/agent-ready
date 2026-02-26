import { createServer } from "node:http";

const pets = [
  { id: "p-1", name: "Milo", species: "cat" },
  { id: "p-2", name: "Rex", species: "dog" }
];

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  const url = new URL(req.url, "http://localhost:4010");

  if (req.method === "GET" && url.pathname === "/pets") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : pets.length;
    sendJson(res, 200, pets.slice(0, Number.isFinite(limit) ? limit : pets.length));
    return;
  }

  if (req.method === "POST" && url.pathname === "/pets") {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    const pet = {
      id: `p-${pets.length + 1}`,
      name: body.name,
      species: typeof body.species === "string" ? body.species : "unknown"
    };
    pets.push(pet);
    sendJson(res, 201, pet);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/pets/")) {
    const petId = url.pathname.split("/")[2];
    const pet = pets.find((item) => item.id === petId);
    if (!pet) {
      sendJson(res, 404, { error: "Pet not found" });
      return;
    }
    sendJson(res, 200, pet);
    return;
  }

  sendJson(res, 404, { error: "Route not found" });
});

server.listen(4010, () => {
  process.stdout.write("Local Pet API running on http://localhost:4010\n");
});
