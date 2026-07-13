import { redirect } from "next/navigation";
import { DOC_SLUGS } from "@/lib/data";

export default function DocsIndex() {
  redirect(`/docs/${DOC_SLUGS[0]}`);
}
