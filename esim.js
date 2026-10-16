import { SAMPLE_PLANS, findDestinations, flagFor } from './esim-catalogue.mjs';

// Deliberately independent of Firebase so the sample browser works without login
// or a connection to external CDNs. No wallet, order or supplier writes here.
const $ = selector => document.querySelector(selector);
const search = $('#esim-search');
const list = $('#destination-list');
let filter = 'all';
let selectedId = null;
const tabs = [$('#buy-tab'), $('#my-tab')];

function selectTab(index, focus = false) {
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = i !== index;
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

function renderDestinations() {
  const destinations = findDestinations(search.value, filter);
  $('#destination-count').textContent = `${destinations.length} sample destination${destinations.length === 1 ? '' : 's'}`;
  list.replaceChildren();
  if (!destinations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const heading = document.createElement('b');
    heading.textContent = 'No destinations match';
    const message = document.createElement('p');
    message.textContent = 'Try another name or switch to All destinations. This preview does not include every destination.';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-ghost btn-sm';
    reset.textContent = 'Clear search and filters';
    reset.addEventListener('click', () => {
      search.value = '';
      setFilter('all');
      search.focus();
    });
    empty.append(heading, message, reset);
    list.append(empty);
    return;
  }
  for (const destination of destinations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'esim-destination';
    button.dataset.destination = destination.id;
    const flag = document.createElement('span');
    flag.className = 'esim-flag';
    flag.setAttribute('aria-hidden', 'true');
    flag.textContent = flagFor(destination);
    const name = document.createElement('b');
    name.textContent = destination.name;
    const count = document.createElement('span');
    count.className = 'esim-count';
    count.textContent = `${SAMPLE_PLANS.length} sample plans`;
    const arrow = document.createElement('span');
    arrow.className = 'esim-chevron';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    button.append(flag, name, count, arrow);
    button.addEventListener('click', () => showPlans(destination));
    list.append(button);
  }
}
function setFilter(value) {
  filter = value;
  document.querySelectorAll('[data-filter]').forEach(button => {
    const on = button.dataset.filter === filter;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  });
  renderDestinations();
}
function showPlans(destination) {
  selectedId = destination.id;
  $('#destinations-view').hidden = true;
  $('#plans-view').hidden = false;
  $('#destination-title').textContent = destination.name;
  $('#destination-flag').textContent = flagFor(destination);
  const plans = $('#plan-list');
  plans.replaceChildren();
  SAMPLE_PLANS.forEach(plan => {
    const card = document.createElement('article');
    card.className = 'esim-plan';
    // Only static, bundled sample values are inserted here; no supplier/user HTML.
    card.innerHTML = `<span class="badge">Sample · Data only</span><h3>${plan.data}</h3>
      <p>${plan.validity} illustrative validity</p><hr><b>Price to be confirmed</b>
      <small>Activation and refund terms pending</small>
      <button class="btn btn-ghost btn-block" type="button" disabled aria-label="Purchase unavailable for ${plan.data} sample plan">Not available yet</button>`;
    plans.append(card);
  });
  $('#destination-title').focus();
}
function backToDestinations() {
  $('#plans-view').hidden = true;
  $('#destinations-view').hidden = false;
  const previous = [...list.querySelectorAll('[data-destination]')].find(button => button.dataset.destination === selectedId);
  (previous || search).focus();
}
$('#back-destinations').addEventListener('click', backToDestinations);
$('#explore-destinations').addEventListener('click', () => {
  selectTab(0);
  backToDestinations();
});
search.addEventListener('input', renderDestinations);
document.querySelectorAll('[data-filter]').forEach(button => {
  button.addEventListener('click', () => setFilter(button.dataset.filter));
});
renderDestinations();
