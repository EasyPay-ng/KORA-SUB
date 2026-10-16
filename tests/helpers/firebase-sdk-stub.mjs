// An in-memory stand-in for the Firestore/Auth functions store.js imports from the
// Firebase CDN. Node cannot fetch the CDN in tests, so a loader hook points those
// import specifiers here; store.js itself is the real file, unchanged.
const state = {
  docs: new Map(),
  auth: { currentUser: null }
};

export function __reset({ docs = {}, user = null } = {}) {
  state.docs = new Map(Object.entries(docs));
  state.auth.currentUser = user;
}
export function __doc(path) {
  return state.docs.get(path);
}
export function __paths() {
  return [...state.docs.keys()];
}

export const initializeApp = () => ({ name: 'stub' });
export const getAuth = () => state.auth;
export class GoogleAuthProvider {}
export const signInWithPopup = async () => { throw new Error('not used in tests'); };
export const signInWithEmailAndPassword = async () => { throw new Error('not used in tests'); };
export const createUserWithEmailAndPassword = async () => { throw new Error('not used in tests'); };
export const updateProfile = async () => {};
export const onAuthStateChanged = (auth, callback) => { callback(state.auth.currentUser); return () => {}; };
export const signOut = async () => {};
export const sendEmailVerification = async () => {};

export const getFirestore = () => ({ name: 'stub-db' });
export const collection = (db, name) => ({ type: 'collection', name });
export const doc = (db, ...parts) => ({ type: 'doc', path: parts.join('/') });
export const query = (ref) => ref;
export const where = () => ({});
export const orderBy = () => ({});
export const limit = () => ({});
export const serverTimestamp = () => ({ __serverTimestamp: true });
export const increment = (amount) => ({ __increment: amount });
export const onSnapshot = () => () => {};
export const addDoc = async () => { throw new Error('not used in tests'); };
export const getDocs = async () => ({ docs: [] });

// Materialise serverTimestamp()/increment() sentinels the way Firestore would.
function resolve(data, previous = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && value.__serverTimestamp) out[key] = new Date(0);
    else if (value && value.__increment !== undefined) out[key] = Number(previous[key] || 0) + value.__increment;
    else out[key] = value;
  }
  return out;
}

const snapshotOf = (ref) => {
  const data = state.docs.get(ref.path);
  return {
    id: ref.path.split('/').pop(),
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : { ...data })
  };
};

export const getDoc = async (ref) => snapshotOf(ref);

export const setDoc = async (ref, data, options = {}) => {
  const previous = state.docs.get(ref.path) || {};
  state.docs.set(ref.path, resolve(data, options.merge ? previous : {}));
};

export const updateDoc = async (ref, data) => {
  const previous = state.docs.get(ref.path) || {};
  state.docs.set(ref.path, { ...previous, ...resolve(data, previous) });
};

export const writeBatch = () => {
  const writes = [];
  return {
    set: (ref, data, options) => writes.push({ kind: 'set', ref, data, options }),
    update: (ref, data) => writes.push({ kind: 'update', ref, data }),
    commit: async () => {
      for (const write of writes) {
        if (write.kind === 'set') await setDoc(write.ref, write.data, write.options || {});
        else await updateDoc(write.ref, write.data);
      }
    }
  };
};

// Like the real thing: reads inside the transaction see committed data only, and the
// writes land together at the end (or not at all if the callback throws).
export const runTransaction = async (db, callback) => {
  const writes = [];
  const tx = {
    get: async (ref) => snapshotOf(ref),
    set: (ref, data) => writes.push({ kind: 'set', ref, data }),
    update: (ref, data) => writes.push({ kind: 'update', ref, data })
  };
  const result = await callback(tx);
  for (const write of writes) {
    if (write.kind === 'set') await setDoc(write.ref, write.data);
    else await updateDoc(write.ref, write.data);
  }
  return result;
};
