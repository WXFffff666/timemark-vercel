/** WebGPU 能力探测（WebLLM q4f16 权重需要 adapter + shader-f16）。 */

export type DeviceCapability = {
  webgpu: boolean;
  adapterOk: boolean;
  shaderF16: boolean;
};

/** 探测浏览器 WebGPU 能力；任何一步失败都返回全 false，绝不抛错 */
export async function probeDeviceCapability(): Promise<DeviceCapability> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return { webgpu: false, adapterOk: false, shaderF16: false };
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) return { webgpu: true, adapterOk: false, shaderF16: false };
  const features = adapter.features as unknown as Set<string>;
  return { webgpu: true, adapterOk: true, shaderF16: features.has('shader-f16') };
}

/** WebLLM 对话可用 = WebGPU + adapter + shader-f16 三者齐备 */
export function isLocalChatCapable(cap: DeviceCapability): boolean {
  return cap.webgpu && cap.adapterOk && cap.shaderF16;
}
