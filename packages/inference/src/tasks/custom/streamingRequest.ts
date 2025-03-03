import type { InferenceTask, Options, RequestArgs } from "../../types";
import { makeRequestOptions } from "../../lib/makeRequestOptions";
import type { EventSourceMessage } from "../../vendor/fetch-event-source/parse";
import { getLines, getMessages } from "../../vendor/fetch-event-source/parse";

/**
 * Primitive to make custom inference calls that expect server-sent events, and returns the response through a generator
 */
export async function* streamingRequest<T>(
	args: RequestArgs,
	options?: Options & {
		/** For internal HF use, which is why it's not exposed in {@link Options} */
		includeCredentials?: boolean;
		/** When a model can be used for multiple tasks, and we want to run a non-default task */
		task?: string | InferenceTask;
		/** To load default model if needed */
		taskHint?: InferenceTask;
	}
): AsyncGenerator<T> {
	const { url, info } = await makeRequestOptions({ ...args, stream: true }, options);
	const response = await (options?.fetch ?? fetch)(url, info);

	if (options?.retry_on_error !== false && response.status === 503 && !options?.wait_for_model) {
		return streamingRequest(args, {
			...options,
			wait_for_model: true,
		});
	}
	if (!response.ok) {
		if (response.headers.get("Content-Type")?.startsWith("application/json")) {
			const output = await response.json();
			if (output.error) {
				throw new Error(output.error);
			}
		}

		throw new Error(`Server response contains error: ${response.status}`);
	}
	if (response.headers.get("content-type") !== "text/event-stream") {
		throw new Error(
			`Server does not support event stream content type, it returned ` + response.headers.get("content-type")
		);
	}

	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	let events: EventSourceMessage[] = [];

	const onEvent = (event: EventSourceMessage) => {
		// accumulate events in array
		events.push(event);
	};

	const onChunk = getLines(
		getMessages(
			() => {},
			() => {},
			onEvent
		)
	);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			onChunk(value);
			for (const event of events) {
				if (event.data.length > 0) {
					const data = JSON.parse(event.data);
					if (typeof data === "object" && data !== null && "error" in data) {
						throw new Error(data.error);
					}
					yield data as T;
				}
			}
			events = [];
		}
	} finally {
		reader.releaseLock();
	}
}
