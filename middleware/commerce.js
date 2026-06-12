export function requireCommercePro(req, res, next) {
  const { commerce_pro_enabled, commerce_pro_status } = req.company || {}
  if (!commerce_pro_enabled || commerce_pro_status !== 'active') {
    return res.status(403).json({
      error: 'Commerce Pro requerido',
      upgrade_url: '/billing/upgrade'
    })
  }
  next()
}
