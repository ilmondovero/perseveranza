// Parser di righe "campo;campo;campo" per tre tipi di record.
// Contratto comune (da preservare nel refactor):
//   - i campi vengono trimmati;
//   - numero di campi diverso dall'atteso -> null;
//   - campo numerico non valido (NaN) -> null;
//   - riga non stringa -> null.

export function parseUser(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split(';').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [id, name, email] = parts;
  const idNum = Number(id);
  if (!Number.isFinite(idNum)) return null;
  return { id: idNum, name, email };
}

export function parseProduct(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split(';').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [sku, desc, price] = parts;
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) return null;
  return { sku, desc, price: priceNum };
}

export function parseOrder(line) {
  if (typeof line !== 'string') return null;
  const parts = line.split(';').map((p) => p.trim());
  if (parts.length !== 4) return null;
  const [orderId, sku, qty, total] = parts;
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum)) return null;
  const totalNum = Number(total);
  if (!Number.isFinite(totalNum)) return null;
  return { orderId, sku, qty: qtyNum, total: totalNum };
}
