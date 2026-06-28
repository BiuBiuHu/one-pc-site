// OAuth 回调：用 code 换 token，再 postMessage 回 CMS 窗口
export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) {
    res.status(400).send("missing code");
    return;
  }
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.OAUTH_CLIENT_ID,
      client_secret: process.env.OAUTH_CLIENT_SECRET,
      code
    })
  });
  const data = await tokenRes.json();
  const token = data.access_token;
  if (!token) {
    res.status(400).send("GitHub 未返回 token");
    return;
  }
  // 把 token 通过 postMessage 传回 Decap CMS
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html><html><body><script>
    (function(){
      var msg = { token: ${JSON.stringify(token)} };
      window.opener && window.opener.postMessage(
        "authorization:github:success:" + JSON.stringify({ token: msg.token, provider: "github" }),
        window.location.origin
      );
    })();
  </script><p style="font-family:sans-serif">登录成功，可关闭此窗口。</p></body></html>`);
}
