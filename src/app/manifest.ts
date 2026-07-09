import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DigitalMate",
    short_name: "DigitalMate",
    description: "一个有稳定人设、能自我进化的私人数字伙伴",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf7f2",
    theme_color: "#e8684a",
    orientation: "portrait",
    icons: [
      {
        src: "/digitalmate-icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/digitalmate-icon.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
