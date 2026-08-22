(() => {
    "use strict";

    // Per-client config -- set window.VIP_COUPON_LOCK_CONFIG BEFORE this script
    // tag in the storefront's header snippet. Defaults below are deliberately
    // generic (no client branding/logo, no hardcoded locale) -- this file is a
    // shared template across clients, not tied to any one deployment.
    const CONFIG = Object.assign(
        {
            // Tiers that already sit at the maximum available loyalty discount —
            // stacking a cart coupon on top of them is not allowed by policy.
            lockedTiers: ["ZR20", "ZR25"],
            message: "You already have the maximum available discount, so a coupon code cannot be applied on top of it.",
            logoUrl: null // optional -- set a client's own logo URL via config, no default
        },
        window.VIP_COUPON_LOCK_CONFIG || {}
    );

    console.log("%cVIP CART COUPON LOCK — blocks coupon at " + CONFIG.lockedTiers.join("/"), "background:#28a745;color:white;padding:4px 8px;font-weight:bold;font-size:12px;border-radius:3px;");

    function getTier() {
        const email = (window.shoptet?.customer?.email || "").trim().toLowerCase();
        if (!email) return null;
        const discount = window.vipDiscounts?.[email];
        if (typeof discount !== "number" || discount <= 0) return null;
        return `ZR${discount}`;
    }

    function findCouponForm() {
        return document.querySelector("[data-testid='formDiscountCoupon']");
    }

    function findCouponInput(form) {
        return form?.querySelector("#discountCouponCode, [data-testid='inputDiscountCoupon']") || null;
    }

    function findCouponSubmit(form) {
        return form?.querySelector("[data-testid='buttonSubmitDiscountCoupon']") || null;
    }

    function findCouponToggle() {
        return document.querySelector("[data-testid='buttonShowCouponInput']");
    }

    function findLockTarget() {
        // Cover the whole coupon block (badge + subtitle + input + button), not just
        // the <form> or just the badge — walk up from the form until we reach an
        // ancestor that also contains the badge, i.e. their smallest common container.
        const form = findCouponForm();
        const badge = document.querySelector(".discount-coupon-badge");
        if (!form) return badge?.closest("div") || null;
        if (!badge) return form;

        let el = form;
        while (el && !el.contains(badge)) {
            el = el.parentElement;
        }
        return el || form;
    }

    function lockCoupon() {
        const target = findLockTarget();
        const toggle = findCouponToggle();
        if (!target && !toggle) return; // coupon UI not on this page (yet) — MutationObserver will retry

        const form = findCouponForm();
        const input = findCouponInput(form);
        const submit = findCouponSubmit(form);

        // Belt and braces: disable the underlying controls too, in case the
        // overlay's positioning gets knocked off by a later Shoptet re-render.
        if (input) input.disabled = true;
        if (submit) submit.disabled = true;
        if (toggle) toggle.disabled = true;

        if (target && !target.querySelector(":scope > .vip-coupon-overlay")) {
            const computed = getComputedStyle(target);
            if (computed.position === "static") {
                target.style.position = "relative";
            }

            const overlay = document.createElement("div");
            overlay.className = "vip-coupon-overlay";
            overlay.style.position = "absolute";
            overlay.style.inset = "0";
            overlay.style.zIndex = "999";
            overlay.style.background = "linear-gradient(135deg, rgba(55,55,55,0.88) 0%, rgba(95,95,95,0.82) 45%, rgba(35,35,35,0.9) 100%)";
            overlay.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.15)";
            overlay.style.borderRadius = "8px";
            overlay.style.pointerEvents = "auto";
            overlay.style.cursor = "default";
            overlay.addEventListener("click", (e) => e.preventDefault());
            overlay.addEventListener("mousedown", (e) => e.preventDefault());

            const msgText = document.createElement("div");
            msgText.style.position = "absolute";
            msgText.style.top = "12px";
            msgText.style.right = "14px";
            msgText.style.width = "220px";
            msgText.style.maxWidth = "60%";
            msgText.style.textAlign = "right";
            msgText.style.color = "#7ed321";
            msgText.style.fontWeight = "700";
            msgText.style.fontSize = "1em";
            msgText.style.lineHeight = "1.35";
            msgText.style.textShadow = "0 1px 2px rgba(0,0,0,0.35)";
            msgText.style.textTransform = "uppercase";
            msgText.textContent = CONFIG.message;
            overlay.appendChild(msgText);

            // Optional per-client logo -- only rendered if a client has set one
            // via window.VIP_COUPON_LOCK_CONFIG.logoUrl. No default image, so a
            // fresh deployment with no config shows the message alone, not
            // another client's branding.
            if (CONFIG.logoUrl) {
                const clientLogo = document.createElement("img");
                clientLogo.src = CONFIG.logoUrl;
                clientLogo.alt = "";
                clientLogo.style.position = "absolute";
                clientLogo.style.right = "14px";
                clientLogo.style.bottom = "12px";
                clientLogo.style.width = "132px";
                clientLogo.style.height = "132px";
                clientLogo.style.objectFit = "contain";
                clientLogo.style.opacity = "0.95";
                clientLogo.style.filter = "drop-shadow(0 1px 3px rgba(0,0,0,0.35))";
                clientLogo.onerror = () => clientLogo.remove(); // logo failed to load — skip silently
                overlay.appendChild(clientLogo);
            }

            target.appendChild(overlay);
        }

        target?.setAttribute("data-vip-coupon-locked", "1");
        if (form) form.dataset.vipCouponLocked = "1";
        if (toggle) toggle.dataset.vipCouponLocked = "1";
    }

    function unlockCoupon() {
        const target = findLockTarget();
        const form = findCouponForm();
        const toggle = findCouponToggle();
        const wasLocked = target?.getAttribute("data-vip-coupon-locked") || form?.dataset.vipCouponLocked || toggle?.dataset.vipCouponLocked;
        if (!wasLocked) return;

        const input = findCouponInput(form);
        const submit = findCouponSubmit(form);

        if (input) input.disabled = false;
        if (submit) submit.disabled = false;
        if (toggle) {
            toggle.disabled = false;
            delete toggle.dataset.vipCouponLocked;
        }
        if (form) delete form.dataset.vipCouponLocked;

        target?.removeAttribute("data-vip-coupon-locked");
        target?.querySelector(":scope > .vip-coupon-overlay")?.remove();
    }

    function run() {
        const tier = getTier();
        if (tier && CONFIG.lockedTiers.includes(tier)) {
            lockCoupon();
        } else {
            unlockCoupon();
        }
    }

    function init() {
        run();
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(run, 200);
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    window.addEventListener("vipReady", run);
    document.addEventListener("shoptet.cart-updated", () => setTimeout(run, 200));
})();
