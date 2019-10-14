import { success, error } from "signale";
import fs, { WriteStream } from "fs";
import Crawler from "crawler";
import cTable from "console.table";
import cheerio from "cheerio";
import { StatisticsManager } from "./statistics";
export type CategoryListType = {
  label: string;
  tag: string;
};

type ParsedRow = {
  pid: string;
  name: string;
  cost: string;
  quantity: string;
  category: string;
  url: string;
};

type ParsedCategory = {
  [id: string]: Array<ParsedRow>;
};

class MydinScrapper {
  private writer: WriteStream;
  private categories: Array<CategoryListType>;
  private pageLimit: number;
  private baseURL: string;
  private batchLength: number;
  private stats: StatisticsManager;
  private crawler: Crawler;
  private currentRunningCategory: number = 0;
  private parsedList: ParsedCategory = {};

  constructor(
    cats: Array<CategoryListType>,
    baseURL: string,
    pageLimit: number = 10,
    batchLength: number = 1
  ) {
    this.categories = cats;
    this.pageLimit = pageLimit;
    this.baseURL = baseURL;
    this.batchLength = batchLength;
    this.initStats();
    this.initCrawler();
  }

  private initCrawler() {
    this.crawler = new Crawler({
      maxConnections: this.batchLength,
      retries: 10
    });
  }
  // https://www.npmjs.com/package/statware
  private initStats() {
    this.stats = new StatisticsManager();
  }

  private getFormattedTime(): string {
    var today = new Date();
    var y = today.getFullYear();
    // JavaScript months are 0-based.
    var m = today.getMonth() + 1;
    var d = today.getDate();
    return y + "-" + m + "-" + d;
  }

  private getFileStream(suffix: string): WriteStream {
    const FOLDER_NAME = `data`;
    const SUBFOLDER_NAME = `${this.getFormattedTime()}`;
    const FILE_NAME = `./${FOLDER_NAME}/${SUBFOLDER_NAME}/${suffix
      .trim()
      .replace(" ", "")
      .toLowerCase()}.csv`;
    let toRet;

    // check if folder already exists?
    if (!fs.existsSync(FOLDER_NAME)) {
      // Make directory
      fs.mkdirSync(FOLDER_NAME);
    }

    if (!fs.existsSync(FOLDER_NAME + "/" + SUBFOLDER_NAME)) {
      // Make directory
      fs.mkdirSync(FOLDER_NAME + "/" + SUBFOLDER_NAME);
    }

    return fs.createWriteStream(FILE_NAME);
  }

  private printToDoc(data: ParsedCategory) {
    Object.keys(data).forEach(categoryKey => {
      let writer = this.getFileStream(categoryKey);
      writer.write(`Product Id; Name; Cost; Quantity; Url; Category\n`); // Start categories items to queue
      let catData = data[categoryKey].forEach(row => {
        writer.write(
          `${row.pid}; ${row.name}; ${row.cost}; ${row.quantity}; ${row.url}; ${row.category}\n`
        );
      });
    });
  }

  private nextPage(category: CategoryListType, pageNumber) {
    // Generate URL
    let url = `${MYDIN_BASE_URL}?catPath=${category.tag}&size=${PAGE_LIMIT}&no=${pageNumber}`;

    // Closure to add to queue
    let pushToQueue = newRl => {
      this.crawler.queue({
        uri: newRl,
        category: category,
        page: pageNumber,
        url: url,
        // Add to parser
        callback: this.parse.bind(this)
      });
    };
    // Add initial url
    pushToQueue(url);
  }

  logStatus(category: CategoryListType, newStatus) {
    this.stats.addStatusUpdate(category.label, newStatus);
  }

  addPageData(category: CategoryListType, newItems: Array<ParsedRow>) {
    this.stats.incrementCount(category.label, newItems.length);
    this.stats.incrementPage(category.label);
    if (!this.parsedList[category.label]) {
      this.parsedList[category.label] = [...newItems];
    } else {
      this.parsedList[category.label] = this.parsedList[category.label].concat(
        ...newItems
      );
    }
    this.rePrintLog();
  }

  logError(error) {
    this.stats.addError(error);
    this.rePrintLog();
  }

  rePrintLog() {
    console.clear();
    let table = this.stats.print();
    table = Object.values(table);
    console.table(cTable.getTable(table));
    let errors = this.stats.printErrors();
    console.log(errors);
  }

  private async parse(error, res, done) {
    let newItems: Array<ParsedRow> = [];
    // Handle Errors
    if (error) {
      this.logError(`${res.options.category.label} - Parsing failed`);
      done();
      return;
    }

    // Use this to check when future rounds are marked as done.
    var markStopped = false;
    // init and crap
    var $ = await cheerio.load(res.body);
    const listItem = await $(".widget-small-product-box-container"); // If No items exist

    // if no objects are found
    if (listItem.length <= 0) {
      // If on first page and no data then show error flag
      if (res.options.page == 1) {
        this.logError(`${res.options.category.label} - No data found`);
        this.logStatus(res.options.category, "🔴 - ERROR");
      } else {
        // else show stoppped flag
        this.logStatus(res.options.category, "✅ - Completed");
      }
      done();
      return;
    }
    // Add next page to queue if size is more than or equal to 100
    if (listItem.length >= PAGE_LIMIT) {
      this.nextPage(res.options.category, ++res.options.page);
    } else {
      // If page size is more than 0 but less than #PAGE_LIMIT then mark this as last round of this category
      markStopped = true;
    }
    // For each list item...
    listItem.each((i, element) => {
      var elm = $(element);

      let prodQuantities = elm.find(
        "div.product-pack-picker.text-center > div.pack-types.text-center > div > div > ul > li"
      );
      //   /products/detail/?pid=10125901005
      if (prodQuantities.length == 0) {
        let aTagOfElement = elm.find("div.product-title > a").attr();
        let regexForPid = /[^products\/detail\/?pid=].*/;
        let itemPid = regexForPid.exec(aTagOfElement.href)[0];
        newItems.push({
          pid: itemPid,
          name: aTagOfElement.title,
          cost: "No price found",
          quantity: "Out of stock",
          category: res.options.category.label,
          url: `${this.baseURL}/detail/?pid=${itemPid}`
        });
      } else {
        prodQuantities.toArray().forEach(quantityBreakDown => {
          let foundItemWithAttribs = quantityBreakDown.attribs;
          let foundItem = {};
          foundItem = JSON.parse(foundItemWithAttribs.value);
          foundItem["ProductName"] = elm
            .find("div.product-title")
            .text()
            .trim();

          if (foundItem) {
            const prodName = foundItem["ProductName"];
            const pid = foundItem["ProductExtId"];
            const prodCost = foundItem["price"];
            const prodQuantity = foundItem["title"];
            newItems.push({
              pid: pid,
              name: prodName,
              cost: prodCost,
              quantity: prodQuantity,
              category: res.options.category.label,
              url: `${this.baseURL}/detail/?pid=${pid}`
            });
          }
        });
      }
    });

    this.logStatus(
      res.options.category,
      markStopped ? "✅ - Completed" : "🌕 - Running"
    );
    this.addPageData(res.options.category, newItems);
    done();
  }

  public run() {
    this.categories.map((cat, index) => {
      this.stats.addCategory(index, cat);
    });

    this.getBatch().forEach(category => {
      this.nextPage(this.categories[this.currentRunningCategory], 1);
      this.currentRunningCategory++;
    });

    let self = this;
    // this.crawler.on("request", options => {
    //   console.log("currentRunningCategory", this.currentRunningCategory);
    // });

    this.crawler.on("drain", () => {
      if (this.currentRunningCategory < this.categories.length - 1) {
        // this.nextPage(this.categories[++this.currentRunningCategory], 1);
        this.getBatch().forEach(category => {
          this.nextPage(this.categories[this.currentRunningCategory], 1);
          this.currentRunningCategory++;
        });
      } else {
        this.printToDoc(this.parsedList);
        success("all done!");
      }
    });
  }

  getBatch(): Array<CategoryListType> {
    let toRet = [];
    for (let index = 0; index < this.batchLength; index++) {
      let cat = this.categories[this.currentRunningCategory + index];
      if (cat) toRet.push(cat);
    }
    return toRet;
  }
}

const mydinCategories: Array<CategoryListType> = [
  { label: "Baby", tag: "%5cCat00001211" },

  { label: "Apparel", tag: "%5CCat00002121" },

  { label: "Chill & Frozen", tag: "%5cCat00001376" },

  { label: "Drinks", tag: "%5cCat00001335" },

  { label: "Fresh", tag: "%5cCat00001555" },

  { label: "Groceries", tag: "%5cCat00001275" },

  { label: "Health & Beauty", tag: "%5cCat00001224" },

  { label: "Home & Outdoor", tag: "%5cCat00001462" },

  { label: "Household Products", tag: "%5cCat00001247" },

  { label: "Muslimin Needs", tag: "%5cCat00001698" },

  { label: "Pets", tag: "%5cCat00001471" },

  { label: "Stationery", tag: "%5cCat00001404" },

  { label: "Super Star", tag: "%5cCat00002021" }
];

const PAGE_LIMIT = 50;
const MYDIN_BASE_URL = "https://www.mydin.com.my/products";
const BATCH_LENGTH = 50;

new MydinScrapper(
  mydinCategories,
  MYDIN_BASE_URL,
  PAGE_LIMIT,
  BATCH_LENGTH
).run();
