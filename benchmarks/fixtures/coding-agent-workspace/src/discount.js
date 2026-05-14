function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function calculateDiscount(cartTotal, customer) {
  if (!customer) {
    return 0;
  }

  if (customer.tier === "premium") {
    return roundMoney(cartTotal * 0.1);
  }

  if (customer.tier === "employee" && cartTotal >= 100) {
    return roundMoney(cartTotal * 0.2);
  }

  return 0;
}

module.exports = { calculateDiscount };
