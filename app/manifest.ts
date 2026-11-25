import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Knowrevo — Your knowledge. Your next customer.",
    short_name: "Knowrevo",
    description:
      "Knowrevo researches prospects, writes from your business knowledge, sends from your Gmail and tracks every open and reply.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7fa",
    theme_color: "#081625",
    icons: [
      { src: "/brand/knowrevo-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/knowrevo-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/knowrevo-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
