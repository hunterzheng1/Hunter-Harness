"use client";

import { useParams } from "next/navigation";

import { ProposalDetail } from "../../../components/console";

export default function ProposalPage() {
  const params = useParams<{ id: string }>();
  return <ProposalDetail proposalId={params.id} />;
}