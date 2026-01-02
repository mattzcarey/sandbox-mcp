// src/test-utils/r2-mock.ts

/**
 * Mock R2 bucket for testing storage services.
 *
 * This provides an in-memory implementation of the R2Bucket interface
 * with support for:
 * - Basic CRUD operations (get, put, delete, list)
 * - Conditional writes with etag matching (optimistic locking)
 * - Simulated failures for error handling tests
 * - Store inspection via _store property
 */

/**
 * Options for configuring mock bucket behavior
 */
interface MockR2BucketOptions {
	/** Simulate get failures */
	failGet?: boolean;
	/** Simulate put failures */
	failPut?: boolean;
	/** Simulate delete failures */
	failDelete?: boolean;
}

/**
 * Extended R2Bucket type that exposes internal store for test assertions
 */
type MockR2Bucket = R2Bucket & {
	/** Internal store for test inspection - maps keys to JSON strings */
	_store: Map<string, string>;
	/** Internal etag store for test inspection */
	_etags: Map<string, string>;
};

/**
 * Creates a mock R2 bucket for testing.
 *
 * The mock supports:
 * - Storing and retrieving JSON data
 * - Conditional writes with etag matching (returns null on mismatch)
 * - Listing objects by prefix
 * - Simulated failures via options
 *
 * @example
 * ```ts
 * const bucket = createMockR2Bucket();
 *
 * // Use in tests
 * await bucket.put("key", JSON.stringify({ foo: "bar" }));
 * const obj = await bucket.get("key");
 * const data = await obj?.json();
 *
 * // Inspect store directly
 * expect(bucket._store.has("key")).toBe(true);
 * ```
 */
export function createMockR2Bucket(
	options?: MockR2BucketOptions,
): MockR2Bucket {
	const store = new Map<string, string>();
	const etags = new Map<string, string>();
	let etagCounter = 0;

	return {
		get: async (key: string) => {
			if (options?.failGet) {
				throw new Error("Simulated R2 get failure");
			}
			const data = store.get(key);
			if (!data) return null;
			return {
				json: async <T>() => JSON.parse(data) as T,
				text: async () => data,
				etag: etags.get(key) ?? "default-etag",
			};
		},

		put: async (key: string, value: string, putOptions?: R2PutOptions) => {
			if (options?.failPut) {
				throw new Error("Simulated R2 put failure");
			}

			// Handle conditional writes (optimistic locking)
			// R2Conditional has etagMatches property for conditional writes
			const onlyIf = putOptions?.onlyIf as { etagMatches?: string } | undefined;
			if (onlyIf?.etagMatches) {
				const currentEtag = etags.get(key);
				if (currentEtag && currentEtag !== onlyIf.etagMatches) {
					return null; // Conditional write failed - etag mismatch
				}
			}

			store.set(key, value);
			const newEtag = `etag-${++etagCounter}`;
			etags.set(key, newEtag);
			return { etag: newEtag };
		},

		delete: async (key: string) => {
			if (options?.failDelete) {
				throw new Error("Simulated R2 delete failure");
			}
			store.delete(key);
			etags.delete(key);
		},

		list: async (listOptions: {
			prefix: string;
			limit?: number;
			cursor?: string;
		}) => {
			const objects: { key: string }[] = [];
			for (const key of store.keys()) {
				if (key.startsWith(listOptions.prefix)) {
					objects.push({ key });
				}
			}
			const limit = listOptions.limit ?? 100;
			return {
				objects: objects.slice(0, limit),
				truncated: objects.length > limit,
				cursor: undefined,
			};
		},

		// Expose internals for test inspection
		_store: store,
		_etags: etags,
	} as unknown as MockR2Bucket;
}
