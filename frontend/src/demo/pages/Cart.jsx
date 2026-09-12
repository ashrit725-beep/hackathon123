import { useState } from "react";
import { Link } from "react-router-dom";
import { Minus, Plus, X } from "lucide-react";
import { formatMoney, shippingFor } from "../lib/money";
import { applyPromo } from "../lib/promo";
import { PageHeader } from "../components/Field";
import { useCart } from "../store/CartContext";

export default function Cart() {
  const { items, setQty, remove, subtotal } = useCart();
  const [promoCode, setPromoCode] = useState("");
  const [promo, setPromo] = useState(null);

  const handleApplyPromo = () => {
    const result = applyPromo(promoCode, subtotal);
    setPromo(result);
  };

  const shipping = shippingFor(subtotal, promo?.freeShipping);
  const total = Math.max(0, subtotal - (promo?.discount || 0) + shipping);

  return (
    <div data-testid="cart-page">
      <PageHeader eyebrow={`${items.length} line item${items.length === 1 ? "" : "s"}`} title={<>Your <span className="italic font-light">cart</span></>} />
      {items.length === 0 ? (
        <div className="bg-white border border-line p-12 text-center reveal" data-testid="cart-empty">
          <p className="text-ink2">Your cart is empty.</p>
          <Link to="/products" className="btn-ghost mt-6" data-testid="cart-browse-btn">Browse the catalog</Link>
        </div>
      ) : (
        <div className="grid lg:grid-cols-5 gap-10">
          <div className="lg:col-span-3 bg-white border border-line divide-y divide-line reveal" data-testid="cart-items">
            {items.map((item) => (
              <div key={item.id} className="p-5 flex gap-5" data-testid={`cart-item-${item.id}`}>
                <img src={item.image} alt={item.name} className="w-20 h-24 object-cover bg-surface" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="font-display text-base text-ink leading-snug">{item.name}</h3>
                    <button onClick={() => remove(item.id)} className="text-mute hover:text-ink" data-testid={`cart-remove-${item.id}`} aria-label="Remove">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="inline-flex items-center border border-line">
                      <button className="px-2.5 py-1.5 text-ink2 hover:text-ink" onClick={() => setQty(item.id, item.qty - 1)} data-testid={`cart-dec-${item.id}`}><Minus size={12} /></button>
                      <span className="w-8 text-center stat-num text-sm" data-testid={`cart-qty-${item.id}`}>{item.qty}</span>
                      <button className="px-2.5 py-1.5 text-ink2 hover:text-ink" onClick={() => setQty(item.id, item.qty + 1)} data-testid={`cart-inc-${item.id}`}><Plus size={12} /></button>
                    </div>
                    <span className="stat-num text-sm">{formatMoney(item.price * item.qty)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <aside className="lg:col-span-2 reveal reveal-1">
            <div className="bg-white border border-line p-6">
              <h2 className="font-display text-lg text-ink mb-5">Summary</h2>
              <div className="flex gap-2">
                <input
                  className="field"
                  placeholder="Promo code"
                  name="promo"
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value)}
                  data-testid="cart-promo-input"
                />
                <button className="btn-ghost whitespace-nowrap" onClick={handleApplyPromo} disabled={!promoCode} data-testid="cart-apply-promo-btn">
                  Apply
                </button>
              </div>
              <dl className="mt-6 space-y-3 text-sm">
                <div className="flex justify-between"><dt className="text-ink2">Subtotal</dt><dd className="stat-num" data-testid="cart-subtotal">{formatMoney(subtotal)}</dd></div>
                {promo && (
                  <div className="flex justify-between text-forest" data-testid="cart-discount-row">
                    <dt>{promo.label}</dt>
                    <dd className="stat-num">−{formatMoney(promo.discount)}</dd>
                  </div>
                )}
                <div className="flex justify-between"><dt className="text-ink2">Shipping</dt><dd className="stat-num" data-testid="cart-shipping">{shipping === 0 ? "Free" : formatMoney(shipping)}</dd></div>
                <div className="flex justify-between border-t border-line pt-3 text-base"><dt className="font-medium">Total</dt><dd className="stat-num font-medium" data-testid="cart-total">{formatMoney(total)}</dd></div>
              </dl>
              <Link to="/checkout" className="btn-ink w-full mt-6" data-testid="cart-checkout-btn">Proceed to checkout</Link>
              <p className="mt-3 text-[11px] text-mute font-mono">Free shipping on orders over $300.</p>
            </div>
            <Link to="/products" className="text-xs text-mute hover:text-ink transition-colors block text-center mt-3" data-testid="cart-continue-shopping">Continue shopping</Link>
          </aside>
        </div>
      )}
    </div>
  );
}
