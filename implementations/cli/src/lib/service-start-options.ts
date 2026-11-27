import { WEB_SERVICE_ADAPTER, type ServiceDefinitionInput } from "@cotal-ai/workspace";

export function serviceStartAllowsNoOpen(name: string | undefined, launch?: ServiceDefinitionInput["launch"]): boolean {
  return name === "web" || (launch?.type === "adapter" && launch.adapter === WEB_SERVICE_ADAPTER);
}

export function serviceStartAllowsIdleExit(name: string | undefined, launch?: ServiceDefinitionInput["launch"]): boolean {
  return launch ? launch.type === "adapter" && launch.adapter === "manager-service" : name === "manager";
}
