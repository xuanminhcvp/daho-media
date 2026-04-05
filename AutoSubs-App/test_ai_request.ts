// MOCK VITE END
global.import = { meta: { env: { DEV: true } } };
const { callAIMultiProviderInternal } = require('./src/utils/ai-provider.ts'); // if we use require it will fail because ts.

// Proper TSX fix:
