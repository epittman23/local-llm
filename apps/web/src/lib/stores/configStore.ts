import { create } from 'zustand';

// A minimal slice of apps/openwebui/src/lib/stores/index.ts's much larger
// `Config` type -- that one carries every feature flag the whole app reads
// (65+ fields); this app only needs `features.enable_benchmarks` so far
// (the Benchmarks gate, see routes/benchmarks/useBenchmarksGate.ts). Extend
// as later phases need more of it, rather than porting the whole shape now
// for fields nothing reads yet.
export type BackendConfig = {
	name: string;
	version: string;
	features?: {
		enable_benchmarks?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

type ConfigState = {
	config: BackendConfig | null;
	setConfig: (config: BackendConfig) => void;
};

export const useConfigStore = create<ConfigState>((set) => ({
	config: null,
	setConfig: (config) => set({ config })
}));
