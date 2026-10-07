/** The shared, immutable part of IronRDP: its compiled code and its glue factory, never an instance or its memory. */
export interface IronRDPSource {
    module: WebAssembly.Module
    createBackend: (module: WebAssembly.Module, level: string) => Promise<any>
}

/** Loads and compiles once; every connection attempt gets fresh glue, classes, memory and allocator. */
export class IronRDPLoader {
    private source: Promise<IronRDPSource> | null = null

    constructor (private load: () => Promise<IronRDPSource>) { }

    async create (level: string): Promise<any> {
        const pending = this.source ??= this.load()
        let source: IronRDPSource
        try {
            source = await pending
        } catch (error) {
            if (this.source === pending) {
                this.source = null
            }
            throw error
        }
        // A failed/trapped instance does not invalidate shared compiled code or another desktop's instance.
        return source.createBackend(source.module, level)
    }
}
