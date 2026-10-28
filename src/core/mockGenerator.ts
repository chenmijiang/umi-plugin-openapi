import fs from "fs";
import { dirname, join } from "path";

import Mock from "mockjs";
import type { OpenAPIObject, OperationObject } from "openapi3-ts/oas30";
import pinyin from "tiny-pinyin";

import OpenAPIParserMock, { type MockValue } from "./openAPIParserMock/index";
import { get, isOperationObject } from "./openAPIParserMock/utils";
import { GenerateServiceProps } from "./types";
import { prettierFile, writeFile } from "./util";

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

const genMockData = (example: MockValue): MockValue => {
  if (!example) {
    return {};
  }

  if (typeof example === "string") {
    return Mock.mock(example);
  }

  if (Array.isArray(example)) {
    return Mock.mock(example);
  }

  return Object.keys(example)
    .map((name) => {
      return {
        [name]: Mock.mock((example as Record<string, MockValue>)[name]) as MockValue,
      };
    })
    .reduce((pre, next) => {
      return {
        ...pre,
        ...next,
      };
    }, {});
};

const genByTemp = ({
  method,
  path,
  parameters,
  status,
  data,
  mockConfig,
}: {
  method: string;
  path: string;
  parameters: OperationObject["parameters"];
  status: string;
  data: string;
  mockConfig: GenerateServiceProps["mockConfig"];
}): string => {
  if (!["get", "put", "post", "delete", "patch"].includes(method.toLocaleLowerCase())) {
    return "";
  }

  let securityPath = path;
  parameters?.forEach((item) => {
    if (!("$ref" in item) && item.in === "path") {
      securityPath = securityPath.replace(`{${item.name}}`, `:${item.name}`);
    }
  });

  if (mockConfig?.msw) {
    return `'${method.toUpperCase()} ${securityPath}': ${data}`;
  }

  return `'${method.toUpperCase()} ${securityPath}': (req: Request, res: Response) => {
    res.status(${status}).send(${data});
  }`;
};

const genMockFiles = (
  mockFunction: string[],
  mockConfig: GenerateServiceProps["mockConfig"],
): string => {
  return prettierFile(`
// @ts-ignore
${mockConfig?.msw ? "" : "import { Request, Response } from 'express'"}


export default {
${mockFunction.join("\n,")}
    }`)[0];
};
export type genMockDataServerConfig = {
  openAPI: OpenAPIObject;
  mockFolder: string;
  mockConfig: GenerateServiceProps["mockConfig"];
};

const mockGenerator = async ({
  openAPI,
  mockFolder,
  mockConfig,
}: genMockDataServerConfig): Promise<void> => {
  const openAPParse = new OpenAPIParserMock(openAPI);
  const docs = openAPParse.parser();
  const pathList = Object.keys(docs.paths);
  const { paths } = docs;
  const mockActionsObj: Record<string, string[]> = {};
  pathList.forEach((path) => {
    const pathConfig = paths[path];
    Object.keys(pathConfig).forEach((method) => {
      const methodConfig: unknown = pathConfig[method as keyof typeof pathConfig];
      if (isOperationObject(methodConfig)) {
        let conte = (
          methodConfig.operationId ||
          methodConfig?.tags?.join("/") ||
          path.replace("/", "").split("/")[1]
        )?.replace(/[^\w^\s^\u4e00-\u9fa5]/gi, "");
        if (conte && /[\u3220-\uFA29]/.test(conte)) {
          conte = pinyin.convertToPinyin(conte, "", true);
        }
        if (!conte) {
          return;
        }
        const data = genMockData(get<MockValue>(methodConfig.responses?.["200"], ["example"]));
        if (!mockActionsObj[conte]) {
          mockActionsObj[conte] = [];
        }
        const tempFile = genByTemp({
          method,
          path,
          parameters: methodConfig.parameters,
          status: "200",
          data: JSON.stringify(data),
          mockConfig,
        });
        if (tempFile) {
          mockActionsObj[conte].push(tempFile);
        }
      }
    });
  });
  Object.keys(mockActionsObj).forEach((file) => {
    if (!file || file === "undefined") {
      return;
    }
    if (file.includes("/")) {
      const dirName = dirname(join(mockFolder, `${file}.ts`));
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName);
      }
    }
    writeFile(mockFolder, `${file}.ts`, genMockFiles(mockActionsObj[file], mockConfig));
  });
  console.log("✅ 生成 mock 文件成功");
};

export { mockGenerator };
