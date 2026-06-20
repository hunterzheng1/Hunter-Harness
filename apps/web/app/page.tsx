"use client";

import { useMemo } from "react";

import { DashboardConsole } from "../components/console";
import { browserApi } from "../lib/api";

export default function DashboardPage() {
  const api = useMemo(browserApi, []);
  return <DashboardConsole api={api} />;
}
