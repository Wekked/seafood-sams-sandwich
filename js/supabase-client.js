// ================================================================
// Supabase Client -- Seafood Sam's Inventory Tracker (Sandwich, MA)
// ================================================================
//
// SETUP: Replace SUPABASE_URL and SUPABASE_ANON_KEY with your values.
//        Find them at: Supabase Dashboard -> Settings -> API Keys
//
var SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
var SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

// Initialize Supabase client with session persistence
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'seafoodsams-sandwich-auth'
  }
});

// ================================================================
// Offline Queue -- stores failed writes and replays when back online
// ================================================================

var OfflineQueue = (function() {
  var STORAGE_KEY = 'seafoodsams-sandwich-offline-queue';
  var _listeners = [];
  var _syncing = false;

  function _load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  }

  function _save(queue) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch(e) { console.error('Failed to save offline queue:', e); }
    _notify();
  }

  function _notify() {
    var count = _load().length;
    _listeners.forEach(function(fn) { fn(count); });
  }

  function enqueue(operation) {
    var queue = _load();
    operation.timestamp = new Date().toISOString();
    operation.id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    queue.push(operation);
    _save(queue);
    console.log('[OfflineQueue] Queued:', operation.type, operation.table);
    return operation.id;
  }

  function count() { return _load().length; }
  function getAll() { return _load(); }

  function onChange(fn) {
    _listeners.push(fn);
    return function() { _listeners = _listeners.filter(function(f) { return f !== fn; }); };
  }

  function sync() {
    if (_syncing) return Promise.resolve({ synced: 0, failed: 0 });
    var queue = _load();
    if (queue.length === 0) return Promise.resolve({ synced: 0, failed: 0 });

    _syncing = true;
    var results = { synced: 0, failed: 0 };

    function processNext(index) {
      if (index >= queue.length) {
        var remaining = queue.filter(function(op) { return !op._synced; });
        _save(remaining);
        _syncing = false;
        return Promise.resolve(results);
      }
      var op = queue[index];
      return _replay(op).then(function(success) {
        if (success) { op._synced = true; results.synced++; }
        else { results.failed++; }
        return processNext(index + 1);
      });
    }
    return processNext(0);
  }

  function _replay(op) {
    var promise;
    switch (op.type) {
      case 'upsert': promise = supabase.from(op.table).upsert(op.data, op.options || {}); break;
      case 'update': promise = supabase.from(op.table).update(op.data).eq(op.matchField, op.matchValue); break;
      case 'update_neq': promise = supabase.from(op.table).update(op.data).neq(op.matchField, op.matchValue); break;
      case 'insert': promise = supabase.from(op.table).insert(op.data); break;
      case 'delete': promise = supabase.from(op.table).delete().eq(op.matchField, op.matchValue); break;
      default: return Promise.resolve(false);
    }
    return promise.then(function(result) {
      return !result.error;
    }).catch(function() { return false; });
  }

  function clear() { _save([]); }

  return { enqueue: enqueue, count: count, getAll: getAll, onChange: onChange, sync: sync, clear: clear };
})();

function supabaseWrite(operation, supabaseCall) {
  if (!navigator.onLine) {
    OfflineQueue.enqueue(operation);
    return Promise.resolve({ data: null, error: null, _queued: true });
  }
  return supabaseCall().then(function(result) {
    if (result.error) {
      var msg = (result.error.message || '').toLowerCase();
      if (msg.indexOf('fetch') !== -1 || msg.indexOf('network') !== -1 || msg.indexOf('failed') !== -1) {
        OfflineQueue.enqueue(operation);
        return { data: null, error: null, _queued: true };
      }
    }
    return result;
  }).catch(function(err) {
    OfflineQueue.enqueue(operation);
    return { data: null, error: null, _queued: true };
  });
}

var SupaAuth = {
  signIn: function(email, password) { return supabase.auth.signInWithPassword({ email: email, password: password }); },
  signOut: function() { return supabase.auth.signOut(); },
  getSession: function() { return supabase.auth.getSession(); },
  onAuthChange: function(callback) { return supabase.auth.onAuthStateChange(callback); },
  getProfile: function(userId) { return supabase.from('profiles').select('*').eq('id', userId).single(); }
};

var SupaDB = {
  loadItems: function() { return supabase.from('items').select('*').order('name', { ascending: true }); },
  saveQuantityChanges: function(changes, items) {
    var now = new Date().toISOString().split('T')[0];
    var updates = Object.keys(changes).map(function(idStr) {
      var id = parseInt(idStr);
      var item = items.find(function(i) { return i.id === id; });
      var newQty = changes[idStr];
      return { id: id, quantity: newQty, total_value: Math.round(newQty * (item ? item.price : 0) * 100) / 100, last_counted: now };
    });
    return supabaseWrite(
      { type: 'upsert', table: 'items', data: updates, options: { onConflict: 'id' } },
      function() { return supabase.from('items').upsert(updates, { onConflict: 'id' }); }
    );
  },
  addItem: function(item) {
    var data = { item_number: item.itemNumber, name: item.name, category: item.category, location: item.location,
      supplier: item.supplier || '',
      quantity: parseFloat(item.quantity) || 0, quantity_unit: item.quantityUnit, price: parseFloat(item.price) || 0,
      price_unit: item.priceUnit, total_value: (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0),
      last_counted: new Date().toISOString().split('T')[0] };
    return supabaseWrite({ type: 'insert', table: 'items', data: data },
      function() { return supabase.from('items').insert(data).select().single(); });
  },
  updateItem: function(item) {
    var qty = parseFloat(item.quantity) || 0; var price = parseFloat(item.price) || 0;
    var data = { item_number: item.itemNumber, name: item.name, category: item.category, location: item.location,
      supplier: item.supplier || '',
      quantity: qty, quantity_unit: item.quantityUnit, price: price, price_unit: item.priceUnit, total_value: Math.round(qty * price * 100) / 100 };
    return supabaseWrite({ type: 'update', table: 'items', data: data, matchField: 'id', matchValue: item.id },
      function() { return supabase.from('items').update(data).eq('id', item.id); });
  },
  deleteItem: function(id) {
    return supabaseWrite({ type: 'delete', table: 'items', matchField: 'id', matchValue: id },
      function() { return supabase.from('items').delete().eq('id', id); });
  },
  closeInventory: function() {
    var now = new Date().toISOString().split('T')[0];
    return supabaseWrite({ type: 'update_neq', table: 'items', data: { last_counted: now, quantity: 0 }, matchField: 'id', matchValue: 0 },
      function() { return supabase.from('items').update({ last_counted: now, quantity: 0 }).neq('id', 0); });
  },
  loadCustomOrders: function() { return supabase.from('location_sort_orders').select('*'); },
  saveCustomOrder: function(location, itemIds) {
    return supabaseWrite({ type: 'upsert', table: 'location_sort_orders', data: { location_name: location, item_order: itemIds }, options: { onConflict: 'location_name' } },
      function() { return supabase.from('location_sort_orders').upsert({ location_name: location, item_order: itemIds }, { onConflict: 'location_name' }); });
  },
  deleteCustomOrder: function(location) {
    return supabaseWrite({ type: 'delete', table: 'location_sort_orders', matchField: 'location_name', matchValue: location },
      function() { return supabase.from('location_sort_orders').delete().eq('location_name', location); });
  },
  subscribeToItems: function(onInsert, onUpdate, onDelete) {
    return supabase.channel('items-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'items' }, function(p) { if (onInsert) onInsert(p.new); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'items' }, function(p) { if (onUpdate) onUpdate(p.new); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'items' }, function(p) { if (onDelete) onDelete(p.old); })
      .subscribe();
  },
  unsubscribe: function(channel) { supabase.removeChannel(channel); }
};

function dbToItem(row) {
  return { id: row.id, category: row.category, itemNumber: row.item_number, name: row.name, location: row.location,
    supplier: row.supplier || '',
    quantity: row.quantity, quantityUnit: row.quantity_unit, price: row.price, priceUnit: row.price_unit,
    totalValue: row.total_value, lastCounted: row.last_counted };
}

window.SupaAuth = SupaAuth;
window.SupaDB = SupaDB;
window.OfflineQueue = OfflineQueue;
window.dbToItem = dbToItem;
