/**
 * 本地 AI 模型契约（模仿知屋 webllm-models.ts；单一事实源）。
 *
 * 为什么用 WebLLM：ONNX/ORT 路径上 Qwen3-0.6B 的 q4/q4f16 导出保留了 float16
 * Cast 节点，ORT wasm/WebGPU 都建不了 session（知屋在三个 ORT 版本上真浏览器
 * 取证一致复现），q4+wasm 实测 0.16 tok/s 不可用。WebLLM 用自研 WebGPU 内核，
 * 完全绕开 ORT，同款权重实测 40+ tok/s。
 *
 * 分档与 GitHub 100MB 硬限（实测）：
 * - phone（0.5B，278MB）：分片全部 <100MB，**直接入库**同源直发、秒开。
 * - chinese（Qwen3-1.7B，~944MB）/ uncensored（Hermes-3-Llama-3.2-3B，~1.7GB，
 *   Nous Research 无审查微调，prebuilt 里唯一 uncensored）：最大分片 155/197MB
 *   超 GitHub 单文件 100MB 硬限，**无法入库**（Git LFS 免费配额 1GB 也不够）。
 *   改为「在线获取档」：不入库、不进构建产物；UI 一键下载 → WebLLM 流式拉取
 *   （默认 hf-mirror，国内可达）→ IndexedDB 永久缓存，之后完全离线。
 *   两个档的 wasm kernel（~5MB）不受限，**入库同源托管**——model_lib 是运行时
 *   硬依赖，raw.githubusercontent 国内不可达。
 *
 * 目录布局：入库模型镜像 HF 的 `<id>/resolve/main/`（web-llm 的 cleanModelUrl 对
 * 不含 /resolve/ 的 URL 一律追加 resolve/main/）。
 */

export type WebLlmModelFile = {
  file: string;
  bytes: number;
  /** sha256（HF tree API 的 lfs.oid；小文件无 LFS 条目则为空串） */
  sha256: string;
};

export type WebLlmModel = {
  /** 档位 id（UI 选择器用，localStorage 持久化） */
  tier: 'phone' | 'chinese' | 'uncensored';
  /** 仓库/模型 id */
  id: string;
  /** 引擎侧 model_id（CreateMLCEngine 传入；与 appConfig.model_list 对齐） */
  engineModelId: string;
  /** 权重获取方式：bundled=同源入库；remote=在线获取（IndexedDB 永久缓存） */
  source: 'bundled' | 'remote';
  /** remote 档的权重基地址（含 resolve/main/，末尾带斜杠） */
  remoteBaseUrl?: string;
  /** 全部文件（权重 + 小件）；就绪判定与打包以它为唯一真源 */
  files: WebLlmModelFile[];
  /** 权重件（.bin）字节总和（进度分母） */
  weightsBytes: number;
  /** wasm kernel 文件名（始终同源 /models/ 托管） */
  kernelFile: string;
  /** kernel 所在同源目录（/models/ 下，末尾带斜杠） */
  kernelDir: string;
  /** UI 展示标签 */
  label: string;
  description: string;
};

const S = (file: string, bytes: number, sha256 = ''): WebLlmModelFile => ({ file, bytes, sha256 });

// ---------------------------------------------------------------------------
// phone：Qwen2.5-0.5B-Instruct-q4f16_1（bundled，分片全 <100MB）
// ---------------------------------------------------------------------------

const PHONE_FILES: WebLlmModelFile[] = [
  S('mlc-chat-config.json', 2041),
  S('tokenizer_config.json', 7308),
  S('tokenizer.json', 7031645),
  S('vocab.json', 2776833),
  S('merges.txt', 1671839),
  S('tensor-cache.json', 102431),
  S('ndarray-cache.json', 102431),
  S('params_shard_0.bin', 68067328, '9f309954d310dc63adfaf3ef6aa987c681b8aa6d1b9686aa2525b454b0d058d5'),
  S('params_shard_1.bin', 33234176, '6d174758dd299d9ef4222b1ad4283be832ebd43853951da25b50501ab1b75ba7'),
  S('params_shard_2.bin', 33505280, '83e0b530bf5c44cbead1a6c220af81040a975f7c81fb708977a02e3ac8d7ffa7'),
  S('params_shard_3.bin', 33053696, '5ff16197c197d8783d398d0c35fa9641e606e6e2dc1d53b9f26a0c9c17a97921'),
  S('params_shard_4.bin', 33020928, 'a7a3d2b02aa9258154f250a714d1743672e423c5c7c8e5c5eefcb9bf337aa0fd'),
  S('params_shard_5.bin', 29211648, '19dfd7a3064b84082915575c0e5a57fc1cd7108828e1ce9fbbbaf9db4b63b9af'),
  S('params_shard_6.bin', 33297408, '192576d43956aa977ec60848b8a7fc8483b5fe38ca9669aa9a3ca2ba795a7a33'),
  S('params_shard_7.bin', 14605824, '1ee25c2a41dad6833e000b7e3ec13a5a1761c32ffbed0ad8a98a6ad313338dc0'),
];

// ---------------------------------------------------------------------------
// chinese：Qwen3-1.7B（remote ~944MB；契约取自知屋 webllm-contracts.json desktop 档，
// sha256 为 HF lfs.oid 实测）
// ---------------------------------------------------------------------------

const CHINESE_FILES: WebLlmModelFile[] = [
  S('merges.txt', 1671853),
  S('mlc-chat-config.json', 2075),
  S('ndarray-cache.json', 134335),
  S('params_shard_0.bin', 155582464, 'a7abd640b7fdc93f45015e9e335004433a6a1bdd32e243dc6751da0ba0dd0394'),
  S('params_shard_1.bin', 26529792, '2f14002a930eebd7230611bdcb7ac97a8b1a22ce85966213a171297ebac2fef1'),
  S('params_shard_10.bin', 28320256, 'bd23d892a34d067c05deb633da99a01b49fda184c2c2448122b875b694610025'),
  S('params_shard_11.bin', 28320256, '375fd71377c3dac502bc7fc8d73cdb6e969b26dfe8bf0b7323de5477719ab48e'),
  S('params_shard_12.bin', 28320256, 'ddb3a9bca9c40904af2609d31824debddb903fbf0bfccbd8feea526c998d0221'),
  S('params_shard_13.bin', 28320256, '4e3b4a29525337d05ec061b39264a5da4ee19ed965dcff027d376c92f0a77dea'),
  S('params_shard_14.bin', 28320256, 'f42d833546e9f6d7206afa6d082ef2cf12dde7baed3bdc90ab787863da044697'),
  S('params_shard_15.bin', 28320256, '2f2212c72b6cfa753112b5493047b7f37fbcd192ea5b96c1aecb8e51a14d0619'),
  S('params_shard_16.bin', 28320256, 'a4ac8a50804cd8009ae6bc5f86070c323a99803a0dbfaa2de9a9e10e1f6965c5'),
  S('params_shard_17.bin', 28320256, '073fbe52bb877d339f77b2fcc7d01a6b1b7e11cb9834acbf027f31fd9e8498cc'),
  S('params_shard_18.bin', 28320256, '189c984a8b40bfde3938e020b2b589b80710455d7f2c5a15af260402b85d9c9a'),
  S('params_shard_19.bin', 28320256, '62c38dbbaf33c594b29665029e5187799bba08d4c339a4fc3c7194daacac3286'),
  S('params_shard_2.bin', 28320256, '3654b87f399699b3026f14476737455ecc1043d88a624024ee0260c1bfe77758'),
  S('params_shard_20.bin', 28320256, '00c9d9217df180ea06278de9aab68d761d7590feb9fe33f4f6932071241fb036'),
  S('params_shard_21.bin', 28320256, 'e0d11a218bfdb9b6f39151fa445c1097f35814bda28ab2edd18a6478e0bf4c99'),
  S('params_shard_22.bin', 28320256, '3052929ab7e9ebfac7645f15e6b72d429ed98685ed48abe66bb2bb18b71e37e4'),
  S('params_shard_23.bin', 28320256, '081d7ca07571138446a33365c9e4f254d6926596517433ec578f6d9adac348ec'),
  S('params_shard_24.bin', 28320256, '29c885aa1611764abc4dbfec803f6fb4ce1d1ea346af6c527f7e626aab836aa6'),
  S('params_shard_25.bin', 28320256, '3d4ef25ac005b136e5f4d3e49c4e25f60e502f8286765d22d556058fb3bf95ed'),
  S('params_shard_26.bin', 28320256, 'c445d07299aec9202a499cec1e8f54d32b14dd0d1c70dd1b04845eb44ca81bcb'),
  S('params_shard_27.bin', 28320256, '36568084cf5fe3077bba9f8827dfa60ab2d5f1d5daa1ea3485a5f87008a9d72c'),
  S('params_shard_28.bin', 28320256, '498df665b6747d41c1ec8e7bb9a173bdd6c6a7e402b69a05a5e580411d59cd26'),
  S('params_shard_29.bin', 21242368, '9170848cd44c77c32ed8c36c49e38230c9f64a7987918bf86cc807498bdad7ac'),
  S('params_shard_3.bin', 28320256, '2efefd0faded422fd20379a8435f5f82328d406bd77b9986873f938430149175'),
  S('params_shard_4.bin', 28320256, 'e10d4e1f357702ee697d8377548a97105f619e9cf6a519a346b15cbcf69ad3de'),
  S('params_shard_5.bin', 28320256, '6cdb44dfa357888c02027c3f33143ac640e78a21f3260f8b520e87ab5a70c2b1'),
  S('params_shard_6.bin', 28320256, 'a03ee4f5ffb35c028c93383022b2ff1e7e43a58e4f2f5459b17b3fed11edad40'),
  S('params_shard_7.bin', 28320256, '510a44ed7477189f65c029541874546e37bc81f12a594b802e0cc816f6eab027'),
  S('params_shard_8.bin', 28320256, '596cdddab0c8a042abd6c22aa69a3f750e048b8210ec6286866a0d3140123ac9'),
  S('params_shard_9.bin', 28320256, '83291442b024362c88d0c2ddb652728b829ce4c3ed37def065f74791a3158e7e'),
  S('tensor-cache.json', 134335),
  S('tokenizer.json', 11422654, 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4'),
  S('tokenizer_config.json', 9675),
  S('vocab.json', 2776833),
];

const UNCENSORED_FILES: WebLlmModelFile[] = [
  S('mlc-chat-config.json', 2513),
  S('ndarray-cache.json', 121041),
  S('params_shard_0.bin', 197001216, 'af8683426f842dd77fbd3093b028c9688b24e37b559cf1c31bf282eb7681da30'),
  S('params_shard_1.bin', 24631296, '665cf09accf8e170b933f28d14c9c421164a836b2aeaddab44e12812f1f19825'),
  S('params_shard_10.bin', 25165824, 'b49ece9a63e2e4037f75fe96d263dbd15280829175caddf6890bf21a0113e51c'),
  S('params_shard_11.bin', 31469568, 'c7d31a74016ea0af987b5ad765314e24295691c43063ae43ad1532d43dc840c0'),
  S('params_shard_12.bin', 25165824, 'f5eadb558ff031b8e273a7bbc5e87193e1313a6540560c36d318cd14d4b34453'),
  S('params_shard_13.bin', 31469568, 'ea8b1cf80589af5a789ccc55bd3148d7d8cce901b3bb9f40056b7e6b6ea53e6e'),
  S('params_shard_14.bin', 25165824, 'a136f0b2ef7c497fa4cb8b0a9990084ff4d10d724c57d98cdc16321498d0a14e'),
  S('params_shard_15.bin', 31469568, '85dc4aff6a64e66ff8e7f1caf35e06af33921c7b6756e84f69c2a5d0215e0a61'),
  S('params_shard_16.bin', 25165824, '2f29bf2b1d718890c6ad5c59ae114c5667b0b6c9a295223c010128607fbb95e7'),
  S('params_shard_17.bin', 31469568, 'a32f46c5c877ce566a68f4657bc88e09961bed0583de172bfc7347e15f846b0f'),
  S('params_shard_18.bin', 25165824, 'f4a6b46d7be2830578a4956daa3532f001af52795c93db71322e3840a961b03e'),
  S('params_shard_19.bin', 31469568, '20e689bc2fc5de13053e19e42c6027d59ba568d52ea79cfc16d728e3de23a1e8'),
  S('params_shard_2.bin', 25165824, 'fb3d8353bff458ba405c8d92c929cd9ea1f4f531682fb995b4c3fbea41b0fdc1'),
  S('params_shard_20.bin', 25165824, '10d75aedcab0f7747fdc183074c5d71034afc44805fb3e52778a0e36fabbf891'),
  S('params_shard_21.bin', 31469568, '15ca75a925730524a02bad8c9a59c98b77df3294f35e641658596c10653c3422'),
  S('params_shard_22.bin', 25165824, 'e855fc563df053a79e9054c92a63a94a76bcc75ecf8ea9d6ca163d1dba1e1275'),
  S('params_shard_23.bin', 31469568, '2cd174fb414d3d7c01a97d2c8d0650bc339dd768c770a6b8f7227f39b4b3dc9b'),
  S('params_shard_24.bin', 25165824, '156222602087d4e9408924889ec5ea59fb73368afe2694d108e30bf3d84c6d98'),
  S('params_shard_25.bin', 31469568, '31f387fd4e4aefee68c55fdda1678d3cb2bd62d3684987044b10781441f17f82'),
  S('params_shard_26.bin', 25165824, '81c34ced9884aaad2b5e6d2b04a6af602ff1145985db7b5762cd20f187906f7d'),
  S('params_shard_27.bin', 25165824, '6586091146d0fb6e4fdb713a5223f05dcb887a24bb2411fdb0f4ec50d5080ee0'),
  S('params_shard_28.bin', 31463424, '0e93491f2c9b60508e9377de00df9cd3523154d931d824ac5b6e1f51f68d878c'),
  S('params_shard_29.bin', 25165824, '71767164c1e6a09e3e6f3bf84ae5058f0b161c328745e1be219709705e286de5'),
  S('params_shard_3.bin', 31469568, '78d56a996873f861ce4f8feb714060263714bb2dccbe94b3d40a995e08113512'),
  S('params_shard_30.bin', 31463424, '0ae0b03fbb5f498f9f9cfab9c70b5538537003b10247a7371ac005bb8cce86d1'),
  S('params_shard_31.bin', 25165824, '857c0b2cf4101b3c18e191e4de89b7660a54ad3e43747f82577c81ec21b93447'),
  S('params_shard_32.bin', 31469568, 'f5ccea26602103b757b5f7fec4a6fdea4a70b0d093c2bf34ddfaa75616bb807b'),
  S('params_shard_33.bin', 25165824, '32e881126e9ad5b42017683440be416225264c379805ce7a1e44bc79e9f8d066'),
  S('params_shard_34.bin', 31469568, '0015b599d2bb656a81190ea3c3ab7295faea46f90cb0be33eb4d3db388204430'),
  S('params_shard_35.bin', 25165824, 'a71596df7204785dad71aad73d49dcfb4e9a7ef0f19c588b8a54aa325969a73a'),
  S('params_shard_36.bin', 31469568, 'e39886da65d15539ff0d97fb5162b70bcff93ea4fd9657509041e4dd8e948d1d'),
  S('params_shard_37.bin', 25165824, 'a8110e2b23c45a5f5af21333774c567776c5e2d86105dbba9d25f611f66bf641'),
  S('params_shard_38.bin', 31469568, '9102c80eea966fbcbb670c96a570ebf7380d86d9fd50f2ca467f17effea2f258'),
  S('params_shard_39.bin', 25165824, 'ce47decffab96ade54bb8c5f4a7fe7bcb5e409931c22716c0759c6aff3da4521'),
  S('params_shard_4.bin', 25165824, '8ddb8ec4bf5b8d56f1436a6b3e6c8317d9f52721546b7866e378930fd7f18067'),
  S('params_shard_40.bin', 31469568, '9545354e75f1e34eae7b592d5129061d9a5bdafe76e8ff14163b5208f8af2e79'),
  S('params_shard_41.bin', 25165824, 'e5148415fa11d32b55f19f916dafe93e8bafedf4115941b3832fed8101038026'),
  S('params_shard_42.bin', 31469568, 'd92b37087efede1df095eb59666d2233c1c6642d3f0b6edc849a532331fa9648'),
  S('params_shard_43.bin', 31481856, 'adc5e9ee13db11fb11d6eb17665df0e76ad360d0cf92227ecf311d76794aabb7'),
  S('params_shard_44.bin', 25165824, '3f707dfdb6f1f0a71fe6ba3e81716ad8589a1ea8ed22ef8a0178893bd598a41a'),
  S('params_shard_45.bin', 31469568, '18aa3e8c07ca50c38e2828ec9edb7ac41abcfa1d28ec80137aeff216caefe475'),
  S('params_shard_46.bin', 25165824, '0d16dc10a857508d3007eb8636574730c44059a1c1ecaa6c00e4fec60512f661'),
  S('params_shard_47.bin', 31469568, '90b2cf5bc902fe19746bba66a33fe77166fd81d0558c7e7c4576e66578dbb94c'),
  S('params_shard_48.bin', 25165824, '468df6c06224b3bc2171e629df772108adfc389c75b75bd57ce486100d566e10'),
  S('params_shard_49.bin', 31469568, '5aaa540cfbe15f4afd6c1fcac08531fcea93f77424e8c354a49494ab295e94ff'),
  S('params_shard_5.bin', 31469568, 'ccf8387352ca008c6a37050a6b7f657a47a873e7823ea9ef4ba7bb5e2e6ad416'),
  S('params_shard_50.bin', 25165824, '8bec36fe89fcd37aaeb8baab262c0fcb735d2cd6ce9588ee3dc75a66d43ac897'),
  S('params_shard_51.bin', 31469568, '9590bb038380bdb5c3a9aa1e41eb34bb4a92c588e511ba342a6afda735dac211'),
  S('params_shard_52.bin', 25165824, 'cd5bdba0397010c7f03b1aeef2b327a8a1c0d509fb2087af3a8356de341fbbee'),
  S('params_shard_53.bin', 31469568, 'd324cd2ba38b91593cd25b157a9e58c725754f55d25e857c1c9f96858279ae41'),
  S('params_shard_54.bin', 25165824, '7beb8a7fdc46f8a1e9e16ae9c3b8a0617328064a9239ba96e227b8cfcc2dcfc8'),
  S('params_shard_55.bin', 31469568, '40978a91b9b96603b5759b9fd4e2fe52e1f305c4b2013a12dedd9ce6404f60d9'),
  S('params_shard_56.bin', 25165824, '5aacc29f10b197488855704abaa419633719ad4aed41ae0e92b3dcd59130075f'),
  S('params_shard_57.bin', 31469568, 'f8a41b3e2d6e900be8364dc351a405d737b12dd000967001665781d1172089d2'),
  S('params_shard_6.bin', 25165824, '4ec7ddf31df3e034716e04e3193cc5fab70287f13f4698fa803f0cc806087078'),
  S('params_shard_7.bin', 31469568, 'e972eb310a501e88d1b6cd22b25e2ef3025da81e357a8932faaba4df12b7aa89'),
  S('params_shard_8.bin', 25165824, 'cfcec8e4889a6c2418ce67e2258fdd7e73abbe845affd860f66be474c1b34e69'),
  S('params_shard_9.bin', 31469568, 'c8b0708d489164c7833e8d04dcf4e3368d4dbbe5cd90d06a243df56c099ac324'),
  S('tensor-cache.json', 121041),
  S('tokenizer.json', 9085140),
  S('tokenizer_config.json', 50329),
];

/** HF 镜像（国内可达）——remote 档的权重获取源 */
export const REMOTE_MODEL_BASE = 'https://hf-mirror.com/';

/** 浏览器内同源模型基地址（末尾带斜杠） */
export function webLlmModelBaseUrl(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/models/`;
}

/** 入库模型目录基地址（HF 布局，末尾带斜杠） */
export function bundledModelBaseUrl(id: string): string {
  return `${webLlmModelBaseUrl()}${id}/resolve/main/`;
}

/** 同源 kernel 绝对地址 */
export function sameOriginKernelUrl(model: WebLlmModel): string {
  return `${webLlmModelBaseUrl()}${model.kernelDir}${model.kernelFile}`;
}

/** 该档的权重获取基地址（remote=hf-mirror；bundled=同源；末尾带斜杠） */
export function modelWeightsBaseUrl(model: WebLlmModel): string {
  if (model.source === 'bundled') return bundledModelBaseUrl(model.id);
  return model.remoteBaseUrl ?? `${REMOTE_MODEL_BASE}${model.id}/resolve/main/`;
}

function buildModel(m: Omit<WebLlmModel, 'weightsBytes'>): WebLlmModel {
  return { ...m, weightsBytes: m.files.filter((f) => f.file.endsWith('.bin')).reduce((n, f) => n + f.bytes, 0) };
}

export const WEBLLM_MODELS: Record<'phone' | 'chinese' | 'uncensored', WebLlmModel> = {
  phone: buildModel({
    tier: 'phone',
    id: 'mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    engineModelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    source: 'bundled',
    files: PHONE_FILES,
    kernelFile: 'Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    kernelDir: 'mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/',
    label: '轻快（278MB · 已内置）',
    description: '随站点直发，秒开；适合快速问答与移动设备',
  }),
  chinese: buildModel({
    tier: 'chinese',
    id: 'mlc-ai/Qwen3-1.7B-q4f16_1-MLC',
    engineModelId: 'Qwen3-1.7B-q4f16_1-MLC',
    source: 'remote',
    remoteBaseUrl: `${REMOTE_MODEL_BASE}mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/main/`,
    files: CHINESE_FILES,
    kernelFile: 'Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm',
    kernelDir: 'mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/main/',
    label: '强力中文（约 944MB · 在线获取）',
    description: '中文质量最好的开放小模型之一；首次点击下载后 IndexedDB 永久缓存，离线可用',
  }),
  uncensored: buildModel({
    tier: 'uncensored',
    id: 'mlc-ai/Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    engineModelId: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    source: 'remote',
    remoteBaseUrl: `${REMOTE_MODEL_BASE}mlc-ai/Hermes-3-Llama-3.2-3B-q4f16_1-MLC/resolve/main/`,
    files: UNCENSORED_FILES,
    kernelFile: 'Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    kernelDir: 'mlc-ai/Hermes-3-Llama-3.2-3B-kernel/',
    label: '无审查（约 1.7GB · 在线获取）',
    description: 'Nous Research Hermes-3：对话不受限、不拒绝；中文一般。首次点击下载后永久缓存',
  }),
};

export type WebLlmTierId = keyof typeof WEBLLM_MODELS;

export const WEBLLM_TIER_IDS: WebLlmTierId[] = ['phone', 'chinese', 'uncensored'];

/** localStorage 键（用户档位选择） */
export const WEBLLM_TIER_STORAGE_KEY = 'timemark:webllm-model';

export function formatWeightsMB(bytes: number): string {
  return `${Math.round(bytes / 1048576)}MB`;
}

/** 向量模型（transformers.js，同源 /models/ 直发） */
export const LOCAL_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
