"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";

import { ProposalDetail } from "../../../components/console";
import { browserApi } from "../../../lib/api";

export default function ProposalPage() {
  const params = useParams<{ id: string }>();
  const api = useMemo(browserApi, []);
  return <ProposalDetail api={api} proposalId={params.id} />;
}
