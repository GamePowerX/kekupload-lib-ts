import CryptoJS from "crypto-js";

export function array_buffer_to_word_array(ab: ArrayBuffer) {
	let i8a = new Uint8Array(ab);
	let a = [];
	for (let i = 0; i < i8a.length; i += 4) {
		a.push((i8a[i] << 24) | (i8a[i + 1] << 16) | (i8a[i + 2] << 8) | i8a[i + 3]);
	}
	return CryptoJS.lib.WordArray.create(a, i8a.length);
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class KekUploadAPI {
	readonly base: string;

	/**
	 * Create a new KekUploadAPI instance.
	 *
	 * @param base The base URL of the KekUpload API
	 *
	 * ```typescript
	 * const api = new KekUploadAPI("https://u.kotw.dev/api/");
	 * ```
	 */
	constructor(base: string) {
		this.base = base;
	}

	async #req(method: HttpMethod, path: string, data: ArrayBuffer | null): Promise<any> {
		return new Promise((resolve, reject) => {
			let xmlHttp = new XMLHttpRequest();
			xmlHttp.onreadystatechange = function () {
				if (xmlHttp.readyState === 4) {
					(xmlHttp.status === 200 ? resolve : reject)(JSON.parse(xmlHttp.response));
				}
			};
			xmlHttp.open(method, `${this.base}${path}`, true);
			xmlHttp.send(data);
		});
	}

	async create(ext: string): Promise<{ stream: string }> {
		return await this.#req("POST", `c/${ext}`, null);
	}

	async upload(stream: string, hash: string, chunk: ArrayBuffer): Promise<{ success: boolean }> {
		return await this.#req("POST", `u/${stream}/${hash}`, chunk);
	}

	async finish(stream: string, hash: string): Promise<{ id: string }> {
		return await this.#req("POST", `f/${stream}/${hash}`, null);
	}

	async remove(stream: string): Promise<{ success: boolean }> {
		return await this.#req("POST", `r/${stream}`, null);
	}
}

export type ChunkedUploaderOptions = {
	api: KekUploadAPI;
};

export class ChunkedUploader {
	readonly #api: KekUploadAPI;
	readonly #hasher;
	#stream: string | undefined;

	/**
	 * Create a new ChunkedUploader.
	 *
	 * @param api The KekUploadAPI to use.
	 *
	 * ```typescript
	 * // Create a new ChunkedUploader
	 * const uploader = new ChunkedUploader({
	 *     api: new KekUploadAPI("https://u.kotw.dev/api/")
	 * });
	 * ```
	 */
	constructor(options: ChunkedUploaderOptions) {
		this.#hasher = CryptoJS.algo.SHA1.create();
		this.#api = options.api;
	}

	/**
	 * Initialize a stream.
	 *
	 * @param ext The file extension
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 * ```
	 */
	async begin(ext: string): Promise<void> {
		this.#stream = (await this.#api.create(ext)).stream;
	}

	/**
	 * Upload a chunk to the stream. You have to run {@link begin} first to initialize the stream.
	 *
	 * @param chunk The chunk to upload
	 * @returns The hash of the chunk
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * const text = "I ❤️ KekUpload";
	 *
	 * // Convert string to ArrayBuffer
	 * const my_chunk = Uint8Array.from(text, x => x.charCodeAt(0));
	 *
	 * // Upload the chunk
	 * const hash = await uploader.upload(chunk);
	 *
	 * // Print out the hash of 'my_chunk'
	 * console.log(hash);
	 * ```
	 */
	upload(chunk: ArrayBuffer): Promise<string> {
		return new Promise(async (resolve, reject) => {
			if (this.#stream === undefined) reject("Stream not initialized. Have you ran 'begin' yet?");

			const word_array = array_buffer_to_word_array(chunk);
			const hash = CryptoJS.SHA1(word_array).toString();
			this.#hasher.update(word_array);

			// Try uploading chunk until it succeeds
			while (true) {
				try {
					await this.#api.upload(this.#stream as string, hash, chunk);
					break;
				} catch (e) {}
			}

			resolve(hash);
		});
	}

	/**
	 * Finish the stream. You have to run {@link begin} first to initialize the stream.
	 *
	 * @returns An object containing the id and hash of the uploaded file
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * // Finish the stream
	 * const {id, hash} = await uploader.finish();
	 * ```
	 */
	async finish(): Promise<{ id: string; hash: string }> {
		if (this.#stream === undefined)
			throw new Error("Stream not initialized. Have you ran 'begin' yet?");

		const hash = this.#hasher.finalize().toString();
		const { id } = await this.#api.finish(this.#stream as string, hash);

		return { id, hash };
	}

	/**
	 * This will destroy the stream. The file will **NOT** be published. You have to run {@link begin} first to initialize the stream.
	 *
	 * @throws Throws an error if the stream is not initialized
	 *
	 * ```typescript
	 * // Destroy the stream to cancel an upload
	 * await uploader.destroy();
	 * ```
	 */
	async destroy(): Promise<void> {
		if (this.#stream === undefined)
			throw new Error("Stream not initialized. Have you ran 'begin' yet?");

		await this.#api.remove(this.#stream as string);
	}
}

export type FileUploaderOptions = ChunkedUploaderOptions & {
	file: File;
	read_size?: number;
	chunk_size?: number;
};

export class FileUploader extends ChunkedUploader {
	readonly #file: File;
	readonly #read_size: number;
	readonly #chunk_size: number;
	#cancel?: () => void;
	#uploading: boolean = false;

	/**
	 * Create a new FileUploader.
	 *
	 * @param options The options passed to the constructor.
	 *
	 * ```typescript
	 * // Create a new FileUploader
	 * const uploader = new FileUploader({
	 *     api: new KekUploadAPI("https://u.kotw.dev/api/"),
	 *     file: file
	 * });
	 * ```
	 */
	constructor(options: FileUploaderOptions) {
		super(options);

		this.#file = options.file;
		// Default 32 MiB
		this.#read_size = options.read_size || 33554432;
		// Default 2 MiB
		this.#chunk_size = options.chunk_size || 2097152;
	}

	/**
	 * Upload the file. You have to run {@link begin} first to initialize the stream.
	 *
	 * @throws Throws an error if the stream is not initialized
	 * @throws Throws an error if {@link cancel} was called
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 *
	 * // Upload the file
	 * await uploader.uploadFile();
	 *
	 * // Finish the stream
	 * const {id, hash} = await uploader.finish();
	 *
	 * // Print out the id and hash of the uploaded file
	 * console.log(id, hash);
	 * ```
	 */
	async upload_file(): Promise<void> {
		this.#uploading = true;

		for (let i = 0; i < this.#file.size; i += this.#read_size) {
			await new Promise((resolve, reject) => {
				// Take a slice of the file with size of our read_size
				const slice = this.#file.slice(i, i + this.#read_size);

				const reader = new FileReader();
				reader.onload = async (e) => {
					const result = e.target?.result as ArrayBuffer;

					for (let f = 0; f < result.byteLength; f += this.#chunk_size) {
						if (this.#cancel) {
							await this.destroy().catch();
							reject("Cancelled");
							this.#cancel();
							return;
						}

						// Take a chunk of the slice with size of our chunk_size
						const chunk = result.slice(f, f + this.#chunk_size);

						// Upload the chunk
						await this.upload(chunk);

						resolve(null);
					}
				};

				reader.readAsArrayBuffer(slice);
			});
		}

		this.#uploading = false;
	}

	/**
	 * Upload the file. You have to run {@link begin} first to initialize the stream.
	 *
	 * @throws Throws an error if not uploading
	 *
	 * ```typescript
	 * // Initialize the stream
	 * await uploader.begin("txt");
	 *
	 * // Upload the file
	 * await uploader.uploadFile();
	 *
	 * // Finish the stream
	 * const {id, hash} = await uploader.finish();
	 *
	 * // Print out the id and hash of the uploaded file
	 * console.log(id, hash);
	 * ```
	 */
	cancel(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.#uploading) reject("Not uploading. Have you ran 'upload_file' yet?");

			this.#cancel = resolve;
		});
	}
}

// export function none() {}

// export type UploadJob = {
// 	file: File;
// 	extension: string;
// 	on_start: () => void;
// 	on_progress: (progress: number) => void;
// 	on_complete: (id: string) => void;
// 	on_error: (error: string) => void;
// 	on_finally: () => void;
// };

// let queue: number[] = [];
// let queue_index: number = 0;
// let jobs: { [key: number]: UploadJob } = {};

// let running: number = 0;
// let active: number = 0;

// let cancel_callback: () => void;

// export function cancel(id: number, on_cancel: () => void) {
// 	if (active === id) cancel_callback = on_cancel;
// 	else {
// 		queue = queue.filter(function (i) {
// 			return i !== id;
// 		});
// 		delete jobs[id];
// 		on_cancel();
// 	}
// }

// export function upload(
// 	file: File,
// 	extension: string,
// 	on_start: () => void = none,
// 	on_progress: (progress: number) => void = none,
// 	on_complete: (id: string) => void = none,
// 	on_error: (error: string) => void = none,
// 	on_finally: () => void = none
// ): number {
// 	let id = queue_index++;
// 	jobs[id] = {
// 		file,
// 		extension,
// 		on_start,
// 		on_progress,
// 		on_complete,
// 		on_error,
// 		on_finally
// 	};
// 	queue.push(id);
// 	work();
// 	return id;
// }

// export async function work() {
// 	if (running++ === 0) {
// 		while (queue.length > 0) {
// 			let id = queue.shift();
// 			active = id;
// 			let job = jobs[id];
// 			delete jobs[id];
// 			await do_job(job);
// 			active = null;
// 		}
// 		running = 0;
// 	}
// }

// export async function do_job(job: UploadJob) {
// 	job.on_start();

// 	let file: File = job.file;

// 	let extension: string = encodeURIComponent(job.extension);

// 	let hasher = CryptoJS.algo.SHA1.create();

// 	let stream: string = await api.create(extension);

// 	let running: boolean = true;

// 	for (let i = 0; i < file.size && running; i += upload_file_chunk) {
// 		await new Promise(function (resolve, reject) {
// 			let slice = file.slice(i, i + upload_file_chunk);

// 			let reader = new FileReader();
// 			reader.onload = async function (e) {
// 				let result = e.target.result as ArrayBuffer;
// 				for (let f = 0; f < result.byteLength && running; f += upload_chunk) {
// 					let success = false;

// 					let chunk = result.slice(f, f + upload_chunk);
// 					let chunk_hash = CryptoJS.SHA1(array_buffer_to_word_array(chunk)).toString();

// 					while (!success) {
// 						if (cancel_callback) {
// 							running = false;
// 							break;
// 						}

// 						try {
// 							await api.upload(stream, chunk_hash, chunk);
// 							success = true;

// 							job.on_progress((i + f) / file.size);
// 						} catch (e) {}
// 					}

// 					hasher.update(array_buffer_to_word_array(chunk));
// 				}

// 				resolve(null);
// 			};

// 			reader.readAsArrayBuffer(slice);
// 		});
// 	}

// 	if (running) {
// 		await api
// 			.finish(stream, hasher.finalize().toString())
// 			.then(job.on_complete)
// 			.catch(job.on_error)
// 			.finally(job.on_finally);
// 	} else {
// 		await api
// 			.remove(stream)
// 			.then(cancel_callback)
// 			.catch(job.on_error)
// 			.finally(function () {
// 				cancel_callback = null;
// 				job.on_finally();
// 			});
// 	}
// }
