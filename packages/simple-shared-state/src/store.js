import merge, { deleted, Swappable } from "./merge";

const shift = [].shift;
const pop = [].pop;
const { isArray } = Array;

/**
 * @class module:SimpleSharedState.Store
 */

const objectPrototype = Object.getPrototypeOf({});


export default class Store {

	constructor(initialState = {}, getActions, useDevtool) {
		let stateTree = Object.assign({}, initialState);
		let dispatching = false;
		let devtool;
		const listeners = new Map();
		const snapshots = new Map();
		const dispatchListeners = new Set();

		const applyBranch = (branch) => {
			dispatching = true;
			stateTree = Object.assign({}, stateTree);
			merge(stateTree, branch);

			listeners.forEach((handler, selector) => {
				const submit = (value) => {
					snapshots.set(selector, value);
					handler(value);
				};
				let change;
				const snapshot = snapshots.get(selector);

				try {
					// attempt selector only on the branch
					change = selector(branch);

					switch(change) {
						case snapshot:
							return;
						case deleted:
							if (snapshot !== undefined) submit(undefined);
							return;
						case pop:
							submit(selector(stateTree));
							return;
						case shift:
							submit(selector(stateTree));
							return;
						case undefined:
							change = selector(stateTree);
							// If ^this line throws, then **current state is also not applicable**,
							// meaning something was deleted, so we should proceed to catch block.

							return;
							// if `return` runs, then selector didn't throw, so exit early
					}
				}
				catch (_) {
					try {
						selector(stateTree);
						return;
					} catch (_) {}
				}

				// this test also covers the scenario where both are undefined
				if (change === snapshot) return;

				submit(merge(snapshot, change));
				// Relates to test "watch > dispatch works with values counting down
				// to zero and up from below zero"
			});

			dispatchListeners.forEach((callback) => callback());
			dispatching = false;
		};

		if (useDevtool && useDevtool.connect && typeof useDevtool.connect === "function") {
			// this adapts SimpleSharedState to work with redux devtools
			devtool = useDevtool.connect();
			devtool.subscribe((message) => {
				if (message.type === "DISPATCH" && message.payload.type === "JUMP_TO_STATE") {
					applyBranch(JSON.parse(message.state));
				}
			});
			devtool.init(stateTree);
		}

		/**
		 * @method module:SimpleSharedState.Store#dispatch
		 *
		 * @param {string} actionName - A string to label this action, this is only used by redux devtools. Normally
		 * you won't call dispatch directly, you'll instead pass an action creators function to
		 * [#createStore]{@link module:SimpleSharedState#createStore}, which will auto-generate this value for you.
		 * @param {object|function} arg - A JavaScript object, or a function which takes state and returns a
		 * JavaScript object. The object may contain any Array or JS primitive, but must be a plain JS object ({})
		 * at the top level, otherwise dispatch will throw.
		 *
		 * @description Takes a branch (or a function which takes state and returns a branch), which is any plain
		 * JS object that represents the desired change to state.
		 *
		 * @example
		 * import { createStore } from "simple-shared-state";
		 *
		 * // Create a store with state:
		 * const store = createStore({
		 *   email: "user@example.com",
		 *   counters: {
		 *     likes: 1,
		 *   },
		 *   todoList: [
		 *     { label: "buy oat milk" },
		 *     { label: "buy cat food" },
		 *   ],
		 * });
		 *
		 * // To change email, call dispatch with a branch. The branch you provide must include the full path
		 * // from the root of the state, to the value you want to change.
		 * store.dispatch("ANY_LABEL_YOU_CHOOSE", {
		 *   email: "me@simplesharedstate.com",
		 * });
		 *
		 * // To increment likes:
		 * store.dispatch("ANY_LABEL_YOU_CHOOSE", (state) => ({
		 *   counters: {
		 *     likes: state.counters.likes + 1,
		 *   },
		 * }));
		 *
		 * // To delete any piece of state, use a reference to `store.deleted` as the value in the branch.
		 * // To remove `counters` from the state entirely:
		 * store.dispatch("ANY_LABEL_YOU_CHOOSE", {
		 *   counters: store.deleted,
		 * });
		 *
		 * // To update items in arrays, you can use `partialArray`:
		 * store.dispatch("ANY_LABEL_YOU_CHOOSE", {
		 *   todoList: partialArray(1, {
		 *     label: "buy oat milk (because it requires 80 times less water than almond milk)",
		 *   }),
		 * });
		 */
		this.dispatch = (actionName, arg) => {
			if (typeof actionName !== "string") throw new Error("dispatch actionName must be a string");
			if (dispatching) throw new Error("can't dispatch while dispatching");

			const branch = typeof arg === "function" ? arg(this.getState()) : arg;

			if (!branch || Object.getPrototypeOf(branch) !== objectPrototype) {
				throw new Error("dispatch expects plain object");
			}

			applyBranch(branch);

			if (devtool) devtool.send(actionName, this.getState());
		};

		/**
		 * @method module:SimpleSharedState.Store#watch
		 * @param {function} selector - A pure function which takes state and returns a piece of that state.
		 * @param {function} handler - The listener which will receive the piece of state when changes occur.
		 * @returns {function} A function to call to remove the listener.
		 *
		 * @description Creates a state listener which is associated with the selector. Every selector must
		 * be globally unique, as they're stored internally in a Set. If `watch` receives a selector which
		 * has already been passed before, `watch` will throw. Refer to the tests for more examples. `watch`
		 * returns a function which, when called, removes the watcher / listener.
		 */
		this.watch = (selector, handler) => {
			if (typeof selector !== "function" || typeof handler !== "function") {
				throw new Error("selector and handler must be functions");
			}
			if (listeners.has(selector)) {
				throw new Error("Cannot reuse selector");
			}

			let snapshot;
			try {
				snapshot = selector(stateTree);
			} catch (_) {}

			listeners.set(selector, handler);
			snapshots.set(selector, snapshot);

			return () => {
				listeners.delete(selector);
				snapshots.delete(selector);
			};
		};

		/**
		 * @method module:SimpleSharedState.Store#watchBatch
		 * @param {Array<function>|Set<function>} selectors - A Set or Array of selector functions. Refer to
		 * [Store#watch]{@link module:SimpleSharedState.Store#watch} for details about selector functions.
		 * @param {function} handler - The listener which will receive the Array of state snapshots.
		 * @returns {function} A callback that removes the dispatch watcher and cleans up after itself.
		 *
		 * @description Creates a dispatch listener from a list of selectors. Each selector yields a snapshot,
		 * which is stored in an array and updated whenever the state changes. When dispatch happens, your
		 * `handler` function will be called with the array of snapshots, ***if*** any snapshots have changed.
		 *
		 * @example
		 * import { createStore, partialArray } from "simple-shared-state";
		 *
		 * const store = createStore({
		 *   people: ["Alice", "Bob"],
		 * });
		 *
		 * const unwatch = store.watchBatch([
		 *   (state) => state.people[0],
		 *   (state) => state.people[1],
		 * ], (values) => console.log(values));
		 *
		 * store.dispatch("", { people: partialArray(1, "John") });
		 * // [ 'Alice', 'John' ]
		 *
		 * store.dispatch("", { people: [ "Janet", "Jake", "James" ] });
		 * // [ 'Janet', 'Jake' ]
		 * // notice "James" is not present, that's because of our selectors
		 *
		 * console.log(store.getState(s => s.people));
		 * // [ 'Janet', 'Jake', 'James' ]
		 *
		 * unwatch();
		 * store.dispatch("", { people: [ "Justin", "Josh", store.deleted ] });
		 * // nothing happens, the watcher was removed
		 *
		 * console.log(store.getState(s => s.people));
		 * // [ 'Justin', 'Josh', <1 empty item> ]
		 */
		this.watchBatch = (selectors, handler) => {
			if (!selectors || typeof selectors.forEach !== "function") {
				throw new Error("selectors must be a list of functions");
			}
			if (typeof handler !== "function") throw new Error("handler is not a function");

			const snapshotsArray = [];

			let i = 0;
			let changed = false;
			selectors.forEach((fn) => {
				if (typeof fn !== "function") {
					selectors.forEach((fn) => listeners.delete(fn));
					throw new Error("selector must be a function");
				}

				let pos = i++; // pos = 0, i += 1
				try {
					snapshotsArray[pos] = fn(stateTree);
				} catch (_) {
					snapshotsArray[pos] = undefined;
				}
				this.watch(fn, (snapshot) => {
					snapshotsArray[pos] = snapshot;
					changed = true;
				});
			});

			const watchHandler = () => {
				if (changed) {
					handler(snapshotsArray.slice()); //map(thingCopier));
					changed = false;
				}
			};
			dispatchListeners.add(watchHandler);

			handler(snapshotsArray.map(thingCopier));

			return () => {
				dispatchListeners.delete(watchHandler);
				selectors.forEach((fn) => listeners.delete(fn));
			};
		};

		/**
		 * @method module:SimpleSharedState.Store#watchDispatch
		 *
		 * @description Listen for the after-dispatch event, which gets called with no arguments after every
		 * dispatch completes. Dispatch is complete after all watchers have been called.
		 *
		 * @param {function} handler - A callback function.
		 */
		this.watchDispatch = (handler) => {
			if (typeof handler !== "function") throw new Error("handler must be a function");
			dispatchListeners.add(handler);
			return () => dispatchListeners.delete(handler);
		};

		/**
		 * @method module:SimpleSharedState.Store#getState
		 *
		 * @param {function} [selector] - Optional but recommended function which returns a piece of the state.
		 * Error handling not required, your selector will run inside a `try{} catch{}` block.
		 * @returns {*} A copy of the state tree, or a copy of the piece returned from the selector, or
		 * undefined if the selector fails.
		 */
		this.getState = (selector) => {
			if (selector && typeof selector === "function") {
				let piece;
				try {
					piece = thingCopier(selector(stateTree));
				} catch (_) {}

				return piece;
			}

			return Object.assign({}, stateTree);
		};

		this.actions = {};
		if (getActions && typeof getActions === "function") {
			const actions = getActions(this);

			Object.keys(actions).forEach((actionName) => {
				const actionType = devtool ? `${actionName}()` : "";

				this.actions[actionName] = (...args) => {
					this.dispatch(actionType, actions[actionName].apply(null, args));
				};
			});
		}
	}
};

/**
 * @function module:SimpleSharedState#swapArray
 *
 * @description If you need to splice out intermediary elements from an array in state, a new
 * array will have to be used to replace the existing array. To accomplish this, wrap the new
 * array in `swapArray()`. `simple-shared-state` will detect the wrapper and replace the
 * existing array with the new.
 *
 * @param {Array} arr - Any array.
 *
 * @example
 * import { createStore, swapArray } from "simple-shared-state";
 *
 * const initialState = {
 *   list: [
 *     { id: 0, text: "A" },
 *     { id: 1, text: "B" },
 *     { id: 2, text: "C" },
 *   ],
 * };
 *
 * // This is how you remove an item by its ID
 * const actions = ({ getState }) => ({
 *
 *   removeByID: (id) => {
 *     const oldList = getState(s => s.list);
 *     const idx = oldList.findIndex((item) => item.id === id);
 *     const newList = oldList.slice(0, idx).concat(oldList.slice(idx + 1, oldList.length));
 *
 *     return {
 *       list: swapArray(newList),
 *     };
 *   },
 *
 * });
 *
 * const store = createStore(initialState, actions);
 *
 * console.log(store.getState());
 * // { list:
 * //   [ { id: 0, text: 'A' },
 * //     { id: 1, text: 'B' },
 * //     { id: 2, text: 'C' } ] }
 *
 * store.actions.removeByID(1);
 *
 * console.log(store.getState());
 * // { list: [ { id: 0, text: 'A' }, { id: 2, text: 'C' } ] }
 */
export const swapArray = (arr) => new Swappable(arr);

/**
 * @function module:SimpleSharedState#partialArray
 * @description This is a helper for making partial arrays from a one-liner. A partial array is
 * used to update a single element in an array.
 *
 * @param {number} pos - the position where `thing` will be placed in the resulting array.
 * @param {object|array|number|boolean|string} thing - any JS primitive which you want to place
 * into the resulting array.
 * @returns {array}
 *
 * @example
 * import { partialArray } from "simple-shared-state";
 *
 * const change = partialArray(2, "thing");
 * console.log(change); // [ <2 empty items>, 'thing' ]
 * console.log(simpleMerge([ 0, 1, 2, 3 ], change)); // [ 0, 1, 'thing', 3 ]
 *
 * @example
 * import { createStore, partialArray } from "simple-shared-state";
 *
 * const initialState = {
 *   list: [
 *     { text: "some text" },
 *     { text: "some more text" },
 *     { text: "far too much text" },
 *   ],
 * };
 *
 * const actions = () => ({
 *   tableFlip: () => ({
 *     list: partialArray(1, {
 *       text: "(╯°□°)╯︵ ┻━┻",
 *     },
 *   }),
 * });
 *
 * const store = createStore(initialState, actions);
 *
 * console.log(store.getState());
 * // { list:
 * //   [ { text: 'some text' },
 * //     { text: 'some more text' },
 * //     { text: 'far too much text' } ] }
 *
 * store.actions.tableFlip();
 *
 * console.log(store.getState());
 * // { list:
 * //   [ { text: 'some text' },
 * //     { text: '(╯°□°)╯︵ ┻━┻' },
 * //     { text: 'far too much text' } ] }
 */
export const partialArray = (pos, thing) => {
	const array = [];
	array[pos] = thing;
	return array;
};

function thingCopier(thing) {
	return !thing || typeof thing !== "object" ? thing : Object.assign(isArray(thing) ? [] : {}, thing);
}
