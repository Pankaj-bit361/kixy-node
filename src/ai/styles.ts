export interface StylePreset {
  id: string;
  label: string;
  prompt: string;
}

export const STYLES: readonly StylePreset[] = [
  { id: "cinematic", label: "Cinematic", prompt: "cinematic film still, dramatic lighting, shallow depth of field, 35mm" },
  { id: "3d-cartoon", label: "3D cartoon", prompt: "3D animated movie style, soft lighting, expressive characters, vibrant colors" },
  { id: "anime", label: "Anime", prompt: "anime illustration, clean line art, cel shading, vivid colors" },
  { id: "watercolor", label: "Watercolor", prompt: "watercolor painting, soft washes, paper texture" },
  { id: "comic", label: "Comic book", prompt: "comic book panel, bold ink outlines, halftone shading" },
  { id: "pixel-art", label: "Pixel art", prompt: "16-bit pixel art, limited palette, crisp pixels" },
  { id: "claymation", label: "Claymation", prompt: "claymation stop-motion style, handmade clay figures, miniature set" },
  { id: "found-footage", label: "Found footage", prompt: "grainy found-footage camcorder frame, VHS noise, timestamp overlay look" },
  { id: "nursery", label: "Nursery rhyme", prompt: "gentle children's picture book illustration, pastel colors, cute rounded shapes" },
  { id: "flat", label: "Flat minimal", prompt: "flat vector illustration, minimal shapes, bold solid colors" },
  { id: "photoreal", label: "Photo real", prompt: "photorealistic, natural light, high detail" },
  { id: "noir", label: "Noir", prompt: "black and white film noir, hard shadows, high contrast" },
];

/** The prompt suffix for a style id; unknown ids get the first style. */
export function stylePrompt(id: string): string {
  return (STYLES.find((s) => s.id === id) ?? STYLES[0]).prompt;
}
