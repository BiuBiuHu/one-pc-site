// 启动 OAuth：把用户跳转到 GitHub 授权页
// 回调到 /api/callback
export default function handler(req, res) {
  const redirectUri = process.env.OAUTH_REDIRECT || `${new URL(req.headers.host ? `https://${req.headers.host}` : "http://localhost:4321").origin}/api/callback`;
  const params = new URLSearchParams({
    client_id: process.env.OAUTH_CLIENT_ID || "",
    redirect_uri: redirectUri,
    scope: "repo"
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}
