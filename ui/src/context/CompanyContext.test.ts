import { describe, expect, it } from "vitest";
import { resolveBootstrapCompanySelection } from "./CompanyContext";

const companies = [{ id: "thesis" }, { id: "keece" }, { id: "bridge" }];

describe("resolveBootstrapCompanySelection", () => {
  it("returns null when there are no companies", () => {
    expect(
      resolveBootstrapCompanySelection({
        companies: [],
        sidebarCompanies: [],
        selectedCompanyId: null,
        storedCompanyId: null,
      }),
    ).toBeNull();
  });

  it("falls back to list order when nothing is configured or stored", () => {
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: companies,
        selectedCompanyId: null,
        storedCompanyId: null,
      }),
    ).toBe("thesis");
  });

  it("opens on the configured default instead of list order", () => {
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: companies,
        selectedCompanyId: null,
        storedCompanyId: null,
        defaultCompanyId: "keece",
      }),
    ).toBe("keece");
  });

  it("lets this browser's stored choice win over the instance default", () => {
    // Otherwise an operator who deliberately switched companies would be
    // yanked back on every reload.
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: companies,
        selectedCompanyId: null,
        storedCompanyId: "bridge",
        defaultCompanyId: "keece",
      }),
    ).toBe("bridge");
  });

  it("ignores a default naming a company that no longer exists", () => {
    // A deleted or archived default must not strand the user on a blank page.
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: companies,
        selectedCompanyId: null,
        storedCompanyId: null,
        defaultCompanyId: "deleted-company",
      }),
    ).toBe("thesis");
  });

  it("keeps an explicit in-session selection ahead of the default", () => {
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: companies,
        selectedCompanyId: "bridge",
        storedCompanyId: null,
        defaultCompanyId: "keece",
      }),
    ).toBe("bridge");
  });

  it("honours the default only when it is visible in the sidebar", () => {
    expect(
      resolveBootstrapCompanySelection({
        companies,
        sidebarCompanies: [{ id: "thesis" }],
        selectedCompanyId: null,
        storedCompanyId: null,
        defaultCompanyId: "keece",
      }),
    ).toBe("thesis");
  });
});
