import { HumanInterviewWorkspace } from "@/components/human-interview/workspace";
import { getQwenSettings } from "@/lib/human-interview/qwen";

export default function HumanInterviewPage() {
  return <HumanInterviewWorkspace modelReady={Boolean(getQwenSettings())} />;
}
