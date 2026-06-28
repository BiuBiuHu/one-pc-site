// 服务页状态用
export default function handler(req, res) {
  res.status(200).json({ ok: true, service: "one-pc-site-api", time: Date.now() });
}
