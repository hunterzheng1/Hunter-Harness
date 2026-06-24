"use client";

import { use } from "react";

import { WorkflowEditor } from "../../../components/workflow-editor";

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WorkflowEditor workflowId={id} />;
}
