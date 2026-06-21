"use client";

import { useParams } from "next/navigation";

import { SkillDetail } from "../../../components/registry";

export default function SkillPage() {
  const params = useParams<{ id: string }>();
  return <SkillDetail skillId={params.id} />;
}
