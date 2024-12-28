const EventEmitter = require("events");
const express = require("express");
const app = express();

app.set("view engine", "ejs");

const port = 3000;

/**
 * @type Map<string, string>
 */
const captchas = new Map();

const verification = new EventEmitter();

/**
 * @param {string} id
 * @returns
 */
const getVerificationUrl = (id) => {
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

module.exports = {
  captchas,
  verification,
  getVerificationUrl,
};
