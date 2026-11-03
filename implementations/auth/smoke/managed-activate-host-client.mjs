const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString());
} catch {
  process.stderr.write("managed activation fixture client needs one JSON request on stdin\n");
  process.exit(2);
}
const response = await fetch(`${input.url}${input.path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${input.cap}` },
  body: JSON.stringify(input.body),
});
process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
