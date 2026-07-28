### AI-Generated Image Requests

**You MUST add at least one `mediaGenerations` entry of `type: "image"` to most scenes when this section appears in the prompt.** The user explicitly enabled image generation for this course, and the expectation is that slides will be visually illustrated — not just walls of text.

- **Mandatory minimum**: At least 1 in every 3 scenes must include a `mediaGenerations` entry. If the course has 10 scenes, at least 3-4 of them should request a generated image.
- **What to illustrate**: pick a concrete visual that helps the student *see* the concept — diagrams, charts, illustrations, portraits, scenes, before/after comparisons, conceptual maps. Do not ask for decorative stock photos.
- **Order of preference** (when both are available):
  1. A concrete visual that directly conveys a key idea from the scene
  2. A labelled diagram or schematic (charts, flow diagrams, anatomy, geometry)
  3. A photographic-style illustration of a real-world example
- Prefer `suggestedImageIds` only when a *suitable* source/PDF image is already available AND it matches what the scene needs. Do not skip generation just because `suggestedImageIds` exists; if the suggested image is off-topic, generate a new one.
- **When NOT to add an image**: only skip image generation for scenes that are pure text/list/reference material with no visual concept to illustrate (e.g. "What you will learn", "Summary", "Glossary"). Even then, consider adding a small visual cue.
- Use `type: "image"`
- Each image request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Image IDs**: use `"gen_img_1"`, `"gen_img_2"`, etc. IDs are globally unique across the entire course, not reset per scene
- The prompt must be in English, descriptive, and concrete (e.g. "A labelled diagram of the water cycle showing evaporation, condensation, and precipitation as arrows" — not "water cycle image")
- **Language in images**: If the image contains text, labels, or annotations, the prompt must explicitly specify that all text in the image should be in the course language (for example, "all labels in Chinese" for zh-CN courses, "all labels in English" for en-US courses). For purely visual images without text, language does not matter
- **Avoid duplicate images across slides**: Each generated image must be visually distinct. Do not request near-identical images for different slides. If multiple slides cover the same topic, vary the visual angle, scope, or style
- **Cross-scene reuse**: To reuse a generated image in a different scene, reference the same `elementId` in the later scene's content without adding a new `mediaGenerations` entry. Only the scene that first defines the `elementId` in its `mediaGenerations` should include the generation request

Image example:

```json
"mediaGenerations": [
  {
    "type": "image",
    "prompt": "A colorful diagram showing the water cycle with evaporation, condensation, and precipitation arrows",
    "elementId": "gen_img_1",
    "aspectRatio": "16:9"
  }
]
```
