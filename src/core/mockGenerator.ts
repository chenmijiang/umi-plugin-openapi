import Mock from "mockjs";
import type { OpenAPIObject } from "openapi3-ts/oas30";

import OpenAPIParserMock, { type MockValue } from "./openAPIParserMock/index";
import { get, httpMethods, isOperationObject, selectResponse } from "./openAPIParserMock/utils";
import { GenerateServiceProps } from "./types";
import { writeFile } from "./util";

Mock.Random.extend({
  country() {
    const data = [
      "阿根廷",
      "澳大利亚",
      "巴西",
      "加拿大",
      "中国",
      "法国",
      "德国",
      "印度",
      "印度尼西亚",
      "意大利",
      "日本",
      "韩国",
      "墨西哥",
      "俄罗斯",
      "沙特阿拉伯",
      "南非",
      "土耳其",
      "英国",
      "美国",
    ];
    const id = (Math.random() * data.length).toFixed();
    return data[Number(id)];
  },
  phone() {
    const phonepreFix = ["111", "112", "114"]; // 自己写前缀哈
    return this.pick(phonepreFix) + Mock.mock(/\d{8}/); // Number()
  },
  status() {
    const status = ["success", "error", "default", "processing", "warning"];
    return status[Number((Math.random() * 4).toFixed(0))];
  },
  authority() {
    const status = ["admin", "user", "guest"];
    return status[Number((Math.random() * status.length).toFixed(0))];
  },
  avatar() {
    const avatar = [
      "https://gw.alipayobjects.com/zos/rmsportal/KDpgvguMpGfqaHPjicRK.svg",
      "https://gw.alipayobjects.com/zos/rmsportal/udxAbMEhpwthVVcjLXik.png",
      "https://gw.alipayobjects.com/zos/antfincdn/XAosXuNZyF/BiazfanxmamNRoxxVxka.png",
      "https://gw.alipayobjects.com/zos/rmsportal/ThXAXghbEsBCCSDihZxY.png",
      "https://gw.alipayobjects.com/zos/rmsportal/OKJXDXrmkNshAMvwtvhu.png",
      "https://avatars0.githubusercontent.com/u/507615?s=40&v=4",
      "https://avatars1.githubusercontent.com/u/8186664?s=40&v=4",
    ];
    const id = (Math.random() * avatar.length).toFixed();
    return avatar[Number(id)];
  },
  group() {
    const data = ["体验技术部", "创新科技组", "前端 6 组", "区块链平台部", "服务技术部"];
    const id = (Math.random() * data.length).toFixed();
    return data[Number(id)];
  },
  label() {
    const label = [
      "很有想法的",
      "小清新",
      "傻白甜",
      "阳光少年",
      "大咖",
      "健身达人",
      "程序员",
      "算法工程师",
      "川妹子",
      "名望程序员",
      "大长腿",
      "海纳百川",
      "专注设计",
      "爱好广泛",
      "IT 互联网",
    ];
    const id = (Math.random() * label.length).toFixed();
    return label[Number(id)];
  },
  href() {
    const href = [
      "https://preview.pro.ant.design/dashboard/analysis",
      "https://ant.design",
      "https://procomponents.ant.design/",
      "https://umijs.org/",
      "https://github.com/umijs/dumi",
    ];
    const id = (Math.random() * href.length).toFixed();
    return href[Number(id)];
  },
});

const hasPrototypeKey = (value: MockValue): boolean => {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "__proto__")) return true;
  return Object.values(value).some(hasPrototypeKey);
};

const mockPreservingKeys = (value: MockValue): MockValue => {
  if (Array.isArray(value)) return value.map(mockPreservingKeys);
  if (value && typeof value === "object") {
    const result: Record<string, MockValue> = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = mockPreservingKeys(child);
    return result;
  }
  return typeof value === "string" ? Mock.mock(value) : value;
};

const genMockData = (example: MockValue): MockValue => {
  if (example === undefined || example === null || typeof example !== "object") {
    return typeof example === "string" ? Mock.mock(example) : example;
  }
  if (hasPrototypeKey(example)) return mockPreservingKeys(example);
  return Mock.mock(example) as MockValue;
};

const genByTemp = ({
  method,
  path,
  status,
  data,
  mockConfig,
}: {
  method: (typeof httpMethods)[number];
  path: string;
  status: string;
  data: string;
  mockConfig: GenerateServiceProps["mockConfig"];
}): string => {
  // Templates may declare path parameters at either PathItem or Operation level.
  const securityPath = path.replace(/\{([^}]+)\}/g, ":$1");
  const routeKey = JSON.stringify(`${method.toUpperCase()} ${securityPath}`);

  if (mockConfig?.msw) {
    return `${routeKey}: ${data}`;
  }

  return `${routeKey}: (req: Request, res: Response) => {
    res.status(${status}).send(${data});
  }`;
};

const genMockFiles = (
  mockFunction: string[],
  mockConfig: GenerateServiceProps["mockConfig"],
): string => {
  return `
// @ts-ignore
${mockConfig?.msw ? "" : "import { Request, Response } from 'express'"}


export default {
${mockFunction.join("\n,")}
    }`;
};
export type genMockDataServerConfig = {
  openAPI: OpenAPIObject;
  mockFolder: string;
  mockConfig: GenerateServiceProps["mockConfig"];
  formatter?: GenerateServiceProps["formatter"];
};

const prepareMock = ({
  openAPI,
  mockFolder,
  mockConfig,
  formatter,
}: genMockDataServerConfig): (() => void) => {
  const openAPParse = new OpenAPIParserMock(openAPI);
  const docs = openAPParse.parser();
  const pathList = Object.keys(docs.paths).filter((path) => path.startsWith("/"));
  const { paths } = docs;
  const mockActionsObj: Record<string, string[]> = Object.create(null);
  pathList.forEach((path) => {
    const pathConfig = paths[path];
    httpMethods.forEach((method) => {
      const methodConfig: unknown = pathConfig[method as keyof typeof pathConfig];
      if (isOperationObject(methodConfig)) {
        const conte =
          (
            methodConfig.operationId ||
            methodConfig?.tags?.join("/") ||
            path.replace(/^\//, "").replace(/\//g, "_") ||
            "root"
          )?.replace(/[^\w^\s^\u4e00-\u9fa5]/gi, "") || "root";
        const { code, status } = selectResponse(methodConfig.responses);
        const data = genMockData(get<MockValue>(methodConfig.responses?.[code], ["example"]));
        const serialized = JSON.stringify(data) ?? "undefined";
        const dataExpression = serialized.includes('"__proto__":')
          ? `JSON.parse(${JSON.stringify(serialized)})`
          : serialized;
        if (!mockActionsObj[conte]) {
          mockActionsObj[conte] = [];
        }
        mockActionsObj[conte].push(
          genByTemp({
            method,
            path,
            status,
            data: dataExpression,
            mockConfig,
          }),
        );
      }
    });
  });
  const files = Object.keys(mockActionsObj).map((file) => ({
    name: `${file}.ts`,
    source: genMockFiles(mockActionsObj[file], mockConfig),
  }));
  return () => {
    let hasFormattingError = false;
    for (const file of files) {
      const hasError = writeFile(mockFolder, file.name, file.source, formatter);
      hasFormattingError = hasError || hasFormattingError;
    }
    if (hasFormattingError) {
      console.warn(
        "[openAPI]: Mock files generated with formatting errors; unformatted content preserved",
      );
    } else {
      console.log("[openAPI]: Mock files generated");
    }
  };
};

export { prepareMock };
