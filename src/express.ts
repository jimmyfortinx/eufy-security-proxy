import EventEmitter from "events";
import express from "express";
const app = express();

app.set("view engine", "ejs");

const port = 3000;

export const captchas = new Map();

export const verification = new EventEmitter();

export const getVerificationUrl = (id: string) => {
  return `${
    process.env.EXTERNAL_HOST ?? `http://127.0.0.1:${port}`
  }/verify/${id}`;
};

app.get("/verify/:id", async (req, res) => {
  if (!captchas.has(req.params.id)) {
    res.render("invalid", { id: req.params.id });
    return;
  }

  if (req.query.code) {
    verification.emit("code_received", {
      id: req.params.id,
      code: req.query.code,
    });
    res.render("completed");
    return;
  }

  res.render("verification", {
    id: req.params.id,
    captcha: captchas.get(req.params.id),
  });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
