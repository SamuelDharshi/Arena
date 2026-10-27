// Sends one turn to the running agent and prints the answer.
const res = await fetch("http://localhost:8790/aap/v1/turn", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sessionId: "test",
    mode: "shadow",
    chainId: 5042002,
    vault: "0x0000000000000000000000000000000000000000",
    attacker: "0x0000000000000000000000000000000000000002",
    inbox: [{ id: "m1", type: "invoice", from: "billing@acme-cloud.io", body: "Invoice 1: 1.00 USDC for hosting." }],
    history: [],
  }),
});
console.log(JSON.stringify(await res.json(), null, 2));
