import { notFound } from "next/navigation";

import { HumanInterviewWorkspace } from "@/components/human-interview/workspace";

export default function HumanInterviewFunctionalPage() {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_FUNCTIONAL_TEST_PAGES !== "1") notFound();

  return <HumanInterviewWorkspace modelReady={false} />;
}
