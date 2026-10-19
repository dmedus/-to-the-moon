// Pionex: cálculo del resultado de los bots (separado de server.js para poder probarlo).

// Mismo criterio que el conector de Pionex: resultado de un bot cerrado según lo devuelto al cerrarse.
function pionexClosed(o, botType) {
  let unlock = Number(o.unlockUsdtAmount);
  if (!o.unlockUsdtAmount || Number.isNaN(unlock)) return null;
  // Grilla spot: además de USDT puede devolver un resto en la moneda base
  if (botType === 'spot_grid' && Number(o.baseAmount) > 0 && Number(o.closedPrice) > 0) unlock += Number(o.baseAmount) * Number(o.closedPrice);
  // Capital agregado a mano: solo se puede calcular si Pionex informa ambas inversiones
  let added = 0;
  if (o.initQuoteInvestment != null && o.quoteInvestment != null) {
    added = Number(o.quoteInvestment) - Number(o.initQuoteInvestment) - Number(o.profitExited || 0);
    if (added <= 0.01) added = 0;
  }
  const putIn = Number(o.initUsdtInvestment || o.usdtInvestment || 0) + added;
  // Bono: el capital es de Pionex (no es inversión propia); lo devuelto al cerrar es ganancia tuya
  if (o.investmentFrom === 'FUTURE_GRID_BONUS') return { invested: 0, profit: unlock };
  const marginOut = Math.max(0, Number(o.initExtraMargin || 0) - Number(o.extraMargin || 0));
  // Ganancia total (grilla + movimiento del precio) = lo devuelto + margen retirado − lo que pusiste.
  // No sumar profitExited: ya está dentro de lo devuelto. Verificado 29/09/2026 contra los aportes reales:
  // aportes + cerrados − capital en bots activos ≈ saldo spot.
  return { invested: putIn, profit: unlock + marginOut - putIn };
}

module.exports = { pionexClosed };
