"use client";

import { useParams } from "next/navigation";

import { ExternalSkillDetail } from "../../../components/external-skill-detail";

export default function ExternalSkillPage() {
  const params = useParams<{ id: string }>();
  return <ExternalSkillDetail skillId={params.id} />;
}
