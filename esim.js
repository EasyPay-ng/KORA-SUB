import {
  findDestinations, groupPlansByDestination, esimOrderTotal, validityLabel, ESIM_MAX_QUANTITY
} from './esim-catalogue.mjs';

// Storefront travel-eSIM browser.
//
// Deliberately Firebase-free: esim.html owns the Firestore wiring and pushes the listed
// plans, the signed-in customer, their wallet balance and their orders in through the
// object this returns. That keeps the whole page drivable by tests, and it means the only
// thing a traveller can read here is what an admin entered — every such value goes in
// through textContent, never innerHTML.
export function createEsimPage(options = {}) {
  const doc = options.doc || document;
  const onBuy = options.onBuy || (async () => { throw new Error('Purchases are not available right now.'); });
  const onSignIn = options.onSignIn || (() => {});
  const onRetry = options.onRetry || (() => {});
  const naira = options.naira || (value => `₦${Math.round(Number(value) || 0).toLocaleString('en-NG')}`);
  const formatDateTime = options.formatDateTime || (() => '—');
  const statusLabel = options.statusLabel || (status => String(status || ''));
  const statusClass = options.statusClass || (() => '');
  const orderLabel = options.orderLabel || (order => [order.destinationName, order.data].filter(Boolean).join(' · '));

  const $ = id => doc.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'hidden') node.hidden = Boolean(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
    return node;
  };

  let plans = [];
  let plansError = '';
  let plansLoaded = false;
  let orders = [];
  let ordersLoaded = false;
  let viewer = null;        // { signedIn, balance } for the signed-in customer
  let filter = 'all';
  let selectedKey = null;   // open destination
  let buyPlanId = null;     // plan whose purchase box is open
  let buying = false;

  const listedPlans = () => plans.filter(plan => plan && plan.active === true);
  const destinations = () => groupPlansByDestination(listedPlans());
  const selected = () => destinations().find(group => group.key === selectedKey) || null;
  const selectedPlan = () => selected()?.plans.find(plan => plan.id === buyPlanId) || null;

  // ---------- Tabs ----------
  const tabs = [doc.getElementById('buy-tab'), doc.getElementById('my-tab')];
  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      doc.getElementById(tab.getAttribute('aria-controls')).hidden = i !== index;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', event => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      selectTab(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true);
    });
  });

  // ---------- Destinations ----------
  function setFilter(value) {
    filter = value;
    doc.querySelectorAll('[data-filter]').forEach(button => {
      const on = button.dataset.filter === filter;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    renderDestinations();
  }

  function renderDestinations() {
    const search = $('esim-search');
    const host = $('destination-list');
    const all = destinations();
    const list = findDestinations(search.value, filter, all);
    host.replaceChildren();

    if (plansError) {
      $('destination-count').textContent = '';
      host.append(el('div', { class: 'empty' }, [
        el('b', { text: 'Could not load eSIM plans' }),
        el('p', { text: plansError }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => onRetry() }, ['Try again'])
      ]));
      return;
    }
    if (!plansLoaded) {
      $('destination-count').textContent = '';
      host.append(el('div', { class: 'empty' }, [el('b', { text: 'Loading plans…' })]));
      return;
    }
    $('destination-count').textContent = all.length
      ? `${list.length} destination${list.length === 1 ? '' : 's'} with live plans`
      : '';

    if (!all.length) {
      host.append(el('div', { class: 'empty' }, [
        el('b', { text: 'No plans listed yet' }),
        el('p', { text: 'We are adding destinations and data allowances. Check back shortly, or tell us where you are travelling and we will find you a plan.' }),
        el('a', { class: 'btn btn-gold btn-sm', href: 'mailto:beniwealth70@gmail.com?subject=eSIM%20enquiry' }, ['Ask about a destination'])
      ]));
      return;
    }
    if (!list.length) {
      host.append(el('div', { class: 'empty' }, [
        el('b', { text: 'No destinations match' }),
        el('p', { text: 'Try another name, or switch to All destinations.' }),
        el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => { search.value = ''; setFilter('all'); search.focus(); }
        }, ['Clear search and filters'])
      ]));
      return;
    }

    for (const destination of list) {
      const row = el('button', {
        class: 'esim-destination', type: 'button', 'data-destination': destination.id,
        onclick: () => showPlans(destination)
      }, [
        el('span', { class: 'esim-flag', 'aria-hidden': 'true', text: destination.flag }),
        el('b', { text: destination.name }),
        el('span', {
          class: 'esim-count',
          text: `${destination.count} plan${destination.count === 1 ? '' : 's'} · from ${naira(destination.fromPrice)}`
        }),
        el('span', { class: 'esim-chevron', 'aria-hidden': 'true', text: '›' })
      ]);
      host.append(row);
    }
  }

  // ---------- Plans for one destination ----------
  // Renders the open destination's plan cards without touching the selection, so a
  // price edit does not throw the traveller out of the purchase box they have open.
  function renderPlanCards() {
    const destination = selected();
    const host = $('plan-list');
    host.replaceChildren();
    if (!destination) return;
    $('destination-title').textContent = destination.name;
    $('destination-flag').textContent = destination.flag;
    for (const plan of destination.plans) {
      const wasHigher = Number(plan.compareAtPrice) > Number(plan.price);
      const price = el('b', {}, wasHigher
        ? [el('s', { class: 'esim-was', text: naira(plan.compareAtPrice) }), ` ${naira(plan.price)}`]
        : [naira(plan.price)]);
      host.append(el('article', { class: 'esim-plan', 'data-plan-card': plan.id }, [
        el('span', { class: 'badge', text: plan.destinationType === 'region' ? 'Multi-country data' : 'Data only' }),
        el('h3', { text: plan.data }),
        el('p', { text: `${validityLabel(plan.validityDays)} validity` }),
        doc.createElement('hr'),
        price,
        el('small', { text: plan.notes || 'Coverage and activation details are confirmed when we deliver your eSIM.' }),
        el('button', {
          class: 'btn btn-gold btn-block', type: 'button', 'data-buy': plan.id,
          'aria-label': `Buy the ${plan.data} plan for ${destination.name}`,
          onclick: () => openBuy(plan.id)
        }, [`Buy ${plan.data}`])
      ]));
    }
    if (buyPlanId && !selectedPlan()) { buyPlanId = null; $('buy-box').hidden = true; }
    paintPay();
  }

  function showPlans(destination) {
    selectedKey = destination.key;
    buyPlanId = null;
    $('destinations-view').hidden = true;
    $('plans-view').hidden = false;
    $('buy-box').hidden = true;
    renderPlanCards();
    $('destination-title').focus();
  }

  function backToDestinations() {
    const previous = selectedKey;
    $('plans-view').hidden = true;
    $('destinations-view').hidden = false;
    $('buy-box').hidden = true;
    buyPlanId = null;
    selectedKey = null;
    const row = [...doc.querySelectorAll('#destination-list [data-destination]')]
      .find(button => button.dataset.destination === (destinations().find(group => group.key === previous)?.id || ''));
    (row || $('esim-search')).focus();
  }

  // ---------- Purchase box ----------
  const quantity = () => Math.round(Number($('buy-quantity').value));

  function openBuy(planId) {
    buyPlanId = planId;
    $('buy-box').hidden = false;
    $('buy-quantity').value = '1';
    $('buy-error').textContent = '';
    paintPay();
    if (viewer?.signedIn) $('buy-quantity').focus();
  }

  function paintPay() {
    const plan = selectedPlan();
    const box = $('buy-box');
    if (!plan) { box.hidden = true; return; }
    $('buy-plan-title').textContent = `${selected()?.name || ''} · ${plan.data} · ${validityLabel(plan.validityDays)}`;
    $('buy-plan-price').textContent = naira(plan.price);
    const signedIn = Boolean(viewer?.signedIn);
    $('buy-signed-out').hidden = signedIn;
    $('buy-signed-in').hidden = !signedIn;
    if (!signedIn) return;
    const balance = Number(viewer.balance || 0);
    const total = esimOrderTotal(plan.price, quantity());
    const short = total ? Math.max(0, total - balance) : 0;
    $('buy-balance').textContent = naira(balance);
    // The button stays clickable whenever a plan is open, so pressing it always says
    // what is wrong instead of leaving the traveller staring at a dead button.
    $('buy-short').textContent = short > 0 ? `You need ${naira(short)} more to pay for this.` : '';
    const button = $('buy-pay');
    button.disabled = buying;
    button.textContent = total ? `Pay ${naira(total)} from wallet` : 'Pay from wallet';
  }

  function showNotice(title, detail, kind = 'ok') {
    $('esim-notice').replaceChildren(el('div', { class: `notice ${kind}` }, [
      el('span', { class: 'notice-icon', text: kind === 'ok' ? '✓' : '!' }),
      el('div', {}, [el('b', { text: title }), el('small', { text: detail })])
    ]));
  }

  async function pay() {
    const plan = selectedPlan();
    if (!plan || buying) return;
    const error = $('buy-error');
    error.textContent = '';
    if (!viewer?.signedIn) { onSignIn(); return; }
    const amount = quantity();
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > ESIM_MAX_QUANTITY) {
      error.textContent = `Choose between 1 and ${ESIM_MAX_QUANTITY} eSIMs per order.`;
      return;
    }
    const total = esimOrderTotal(plan.price, amount);
    if (!total) { error.textContent = 'This plan has no valid price right now.'; return; }
    if (Number(viewer.balance || 0) < total) {
      error.textContent = `Your wallet has ${naira(viewer.balance)} but this costs ${naira(total)}. Fund your wallet first.`;
      return;
    }
    buying = true;
    const button = $('buy-pay');
    button.disabled = true;
    button.textContent = 'Processing…';
    try {
      const result = await onBuy(plan.id, amount);
      buyPlanId = null;
      $('buy-box').hidden = true;
      showNotice('eSIM ordered',
        `Reference ${String(result?.orderId || '').slice(-8).toUpperCase()}. ${naira(result?.total ?? total)} was paid from your wallet — your activation details appear under My eSIMs once we deliver them.`);
      renderOrders();
      selectTab(1);
    } catch (problem) {
      error.textContent = problem?.message || 'Could not place the order.';
    } finally {
      buying = false;
      button.disabled = false;
      paintPay();
    }
  }

  // ---------- My eSIMs ----------
  function renderOrders() {
    const host = $('esim-orders');
    host.replaceChildren();
    if (!viewer?.signedIn) {
      host.append(el('div', { class: 'esim-coming' }, [
        el('span', { class: 'esim-empty-icon', 'aria-hidden': 'true', text: '▣' }),
        el('h2', { text: 'Sign in to see your eSIMs' }),
        el('p', { text: 'Your plans, their status and the activation details we send you are kept with your KORASTORE account.' }),
        el('button', { class: 'btn btn-gold', type: 'button', onclick: () => onSignIn() }, ['Sign in'])
      ]));
      return;
    }
    if (!ordersLoaded) {
      host.append(el('div', { class: 'empty' }, [el('b', { text: 'Loading your eSIMs…' })]));
      return;
    }
    if (!orders.length) {
      host.append(el('div', { class: 'esim-coming' }, [
        el('span', { class: 'esim-empty-icon', 'aria-hidden': 'true', text: '▣' }),
        el('h2', { text: 'Your next connection starts here' }),
        el('p', { text: 'Buy a plan and it will appear here with its status and your activation details.' }),
        el('button', { class: 'btn btn-gold', type: 'button', onclick: () => selectTab(0) }, ['Explore destinations →'])
      ]));
      return;
    }
    for (const order of orders) {
      const card = el('article', { class: 'order' }, [
        el('div', { class: 'order-head' }, [
          el('div', {}, [
            el('b', { text: `eSIM ${String(order.id || '').slice(-8).toUpperCase()}` }),
            el('div', { class: 'small muted', text: formatDateTime(order.createdAt) })
          ]),
          el('div', { class: 'row' }, [
            el('span', { class: `badge ${statusClass(order.status)}`, text: statusLabel(order.status) }),
            el('b', { class: 'mono', style: 'color:var(--navy)', text: naira(order.total) })
          ])
        ]),
        el('ul', { class: 'order-items' }, [
          el('li', {}, [
            el('span', { text: `${orderLabel(order)} · ${validityLabel(order.validityDays)} × ${Number(order.quantity || 1)}` }),
            el('span', { text: naira(order.total) })
          ]),
          el('li', {}, [el('span', { class: 'muted', text: 'Sent to' }), el('span', { class: 'small', text: order.email || 'your account email' })])
        ])
      ]);
      if (order.instructions) {
        card.append(el('div', { class: 'notice ok', style: 'margin-top:14px' }, [
          el('span', { class: 'notice-icon', text: '✓' }),
          el('div', {}, [el('b', { text: 'Your activation details' }), el('small', { text: order.instructions })])
        ]));
      }
      if (order.status === 'cancelled') {
        card.append(el('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'Cancelled — the full amount was refunded to your wallet.' }));
      } else if (order.status === 'paid' || order.status === 'processing') {
        card.append(el('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'We are preparing your eSIM. Install it over Wi-Fi as soon as the details arrive.' }));
      }
      host.append(card);
    }
  }

  // ---------- Wiring ----------
  $('back-destinations').addEventListener('click', backToDestinations);
  $('esim-search').addEventListener('input', renderDestinations);
  doc.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  });
  $('buy-quantity').addEventListener('input', paintPay);
  $('buy-pay').addEventListener('click', pay);
  $('buy-signin').addEventListener('click', () => onSignIn());
  renderDestinations();
  renderOrders();

  return {
    setPlans(rows) {
      plans = Array.isArray(rows) ? rows : [];
      plansLoaded = true;
      plansError = '';
      // A destination whose plans were all hidden sends the traveller back to the list.
      if (selectedKey && !selected()) backToDestinations();
      renderDestinations();
      if (!$('plans-view').hidden) renderPlanCards();
      paintPay();
    },
    setPlansError(message) {
      plansError = String(message || 'Check your connection and try again.');
      plansLoaded = true;
      renderDestinations();
    },
    setViewer(next) {
      viewer = next && next.signedIn ? { signedIn: true, balance: Number(next.balance || 0) } : null;
      paintPay();
      renderOrders();
    },
    setOrders(rows) {
      orders = Array.isArray(rows) ? rows : [];
      ordersLoaded = true;
      renderOrders();
    },
    setOrdersError(message) {
      ordersLoaded = true;
      orders = [];
      $('esim-orders').replaceChildren(el('div', { class: 'empty' }, [
        el('b', { text: 'Could not load your eSIMs' }),
        el('p', { text: String(message || '') })
      ]));
    },
    selectTab
  };
}
